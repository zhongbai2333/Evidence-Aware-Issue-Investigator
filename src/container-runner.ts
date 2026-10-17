import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentInvocationPlan } from "./contracts";
import { copyDisposableWorkspace, normalizeAgentOutput, parseObservedCommands, type AgentRunResult } from "./runner";
import { startCredentialProxy, type CredentialProxyHandle } from "./proxy";
import { investigationReportSchema } from "./report";
import { REPORT_JSON_SCHEMA } from "./schema";
import { containsCredential, controllerSecrets, screenText } from "./boundary";

const MAX_CAPTURE = 1_000_000;
const SESSION = "/work/session";
const PRIVATE_NETWORKS = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "168.63.129.16/32"];

// Only the controller invokes these host tools; no agent-controlled command is passed to a host shell.
async function execute(command: string, args: string[], timeoutMs = 60_000, input?: Buffer) {
  const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", overflow = false;
  const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > MAX_CAPTURE) {
      overflow = true; child.kill("SIGKILL"); return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const code = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} exceeded its time budget`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (value) => { clearTimeout(timer); resolve(value ?? 1); });
  });
  if (overflow) throw new Error("Isolated process output exceeded the capture budget");
  return { code, stdout, stderr };
}

async function checked(command: string, args: string[], timeoutMs?: number) {
  const result = await execute(command, args, timeoutMs);
  if (result.code !== 0) throw new Error(`${command} failed (${result.code}): ${screenText(result.stderr).replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted-url]").slice(-1500)}`);
  return result.stdout.trim();
}

async function stageArchive(stage: string, container: string): Promise<void> {
  const pack = spawn("tar", ["-C", stage, "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"] });
  const unpack = spawn("docker", ["exec", "-i", container, "tar", "--no-same-owner", "-xf", "-", "-C", SESSION], { stdio: ["pipe", "ignore", "pipe"] });
  pack.stdout.pipe(unpack.stdin);
  unpack.stdin.on("error", () => {});
  pack.stderr.resume(); unpack.stderr.resume();
  try {
    await Promise.all([pack, unpack].map((child) => new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Container input staging failed")));
    })));
  } finally { pack.kill("SIGKILL"); unpack.kill("SIGKILL"); }
}

async function screenWorkspace(root: string, secrets: string[], counter = { files: 0, bytes: 0 }): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { await screenWorkspace(file, secrets, counter); continue; }
    if (!entry.isFile()) continue;
    const info = await lstat(file);
    counter.files++; counter.bytes += info.size;
    if (counter.files > 20_000 || counter.bytes > 128 * 1024 * 1024 || info.size > 20 * 1024 * 1024) {
      throw new Error("Input workspace exceeds the screening budget");
    }
    const content = (await readFile(file)).toString("utf8");
    if (containsCredential(content, secrets)) throw new Error("Input credential screening rejected a workspace file; no source material was sent to the agent");
  }
}

export async function runContainerAgent(plan: AgentInvocationPlan): Promise<AgentRunResult> {
  const limits = plan.isolation;
  if (process.platform !== "linux") throw new Error("Container isolation requires a Linux Docker host; refusing to fall back to a host process");
  if (!limits?.image || !/^(?:[A-Za-z0-9./:_-]+@)?sha256:[0-9a-f]{64}$/.test(limits.image)) throw new Error("An immutable container image is required");
  if (!plan.credentialProxy || Object.values(plan.environment).some((value) => value.fromEnv)) throw new Error("Container agents must use only a controller credential proxy");
  const stage = await mkdtemp(path.join(os.tmpdir(), "eai-container-input-"));
  const name = `eai-${randomUUID()}`;
  let proxy: CredentialProxyHandle | null = null;
  let networkCreated = false, containerCreated = false;
  const secrets = controllerSecrets();
  const sourceSecret = process.env[plan.credentialProxy.sourceEnv];
  if (sourceSecret) secrets.push(sourceSecret);
  try {
    await copyDisposableWorkspace(plan.cwd, path.join(stage, "workspace"));
    await screenWorkspace(path.join(stage, "workspace"), secrets);
    await mkdir(path.join(stage, "home"));
    await writeFile(path.join(stage, "report.schema.json"), JSON.stringify(REPORT_JSON_SCHEMA));
    await checked("docker", ["network", "create", "--driver", "bridge", name]);
    networkCreated = true;
    const gateway = await checked("docker", ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", name]);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) throw new Error("Invalid isolated network gateway");
    proxy = await startCredentialProxy({ ...plan.credentialProxy, allowedModel: plan.model ?? undefined,
      maxRequests: limits.modelRequests, maxOutputTokens: limits.maxOutputTokens }, gateway);
    const variables: Record<string, string> = {
      tempDir: SESSION, workspace: `${SESSION}/workspace`, schemaPath: `${SESSION}/report.schema.json`,
      outputPath: `${SESSION}/report.json`, proxyBaseUrl: proxy.baseUrl, proxyToken: proxy.token,
    };
    const substitute = (value: string) => Object.entries(variables).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, replacement), value);
    for (const [relative, content] of Object.entries(plan.generatedFiles)) {
      const dest = path.resolve(stage, relative);
      if (!dest.startsWith(`${stage}${path.sep}`)) throw new Error("Generated file escapes input staging");
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, substitute(content));
    }
    const environment: Record<string, string> = {
      HOME: `${SESSION}/home`, USERPROFILE: `${SESSION}/home`, CARGO_HOME: "/work/cargo", TMPDIR: "/tmp",
    };
    for (const [key, value] of Object.entries(plan.environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid container environment name");
      environment[key] = substitute(value.value ?? "");
    }
    await checked("docker", ["create", "--name", name, "--network", name, "--user", "1000:1000", "--init",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--pids-limit", String(limits.pids),
      "--memory", `${limits.memoryMb}m`, "--memory-swap", `${limits.memoryMb}m`, "--cpus", String(limits.cpus),
      "--ulimit", "nofile=1024:1024", "--ulimit", "core=0:0", "--log-driver", "none",
      "--tmpfs", `/work:rw,exec,nosuid,nodev,size=${limits.diskMb}m,uid=1000,gid=1000,mode=0700`,
      "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m,mode=1777", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
      "--entrypoint", "/usr/bin/sleep", limits.image, "infinity"]);
    containerCreated = true;
    await checked("docker", ["start", name]);
    const pid = await checked("docker", ["inspect", "--format", "{{.State.Pid}}", name]);
    if (!/^\d+$/.test(pid) || Number(pid) < 2) throw new Error("Invalid container namespace PID");
    const firewall = async (...args: string[]) => await checked("sudo", ["-n", "nsenter", "-t", pid, "-n", "--", "iptables", ...args]);
    // No untrusted program runs before this namespace policy is installed. Missing support fails closed.
    await firewall("-P", "OUTPUT", "DROP");
    await firewall("-A", "OUTPUT", "-o", "lo", "-j", "ACCEPT");
    await firewall("-A", "OUTPUT", "-d", gateway, "-p", "tcp", "--dport", new URL(proxy.baseUrl).port, "-j", "ACCEPT");
    for (const range of PRIVATE_NETWORKS) await firewall("-A", "OUTPUT", "-d", range, "-j", "REJECT");
    await firewall("-A", "OUTPUT", "-m", "quota", "--quota", String(limits.publicNetworkMb * 1024 * 1024), "-j", "ACCEPT");
    await checked("sudo", ["-n", "nsenter", "-t", pid, "-n", "--", "ip6tables", "-P", "OUTPUT", "DROP"]);
    await checked("sudo", ["-n", "nsenter", "-t", pid, "-n", "--", "tc", "qdisc", "add", "dev", "eth0", "root", "tbf", "rate", "20mbit", "burst", "64kb", "latency", "400ms"]);
    await checked("docker", ["exec", name, "mkdir", "-p", SESSION]);
    await stageArchive(stage, name);
    const envArgs = Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    if (plan.versionCheck) {
      const version = await checked("docker", ["exec", ...envArgs, name, plan.versionCheck.command, ...plan.versionCheck.args], 30_000);
      if (plan.versionCheck.expectedVersion && !version.includes(plan.versionCheck.expectedVersion)) throw new Error("Container Codex version mismatch");
    }
    const result = await execute("docker", ["exec", "--workdir", `${SESSION}/workspace`, ...envArgs,
      name, plan.command, ...plan.args.map(substitute)], plan.timeoutMs);
    // Revoke all model access and kill agent background processes before processing its results.
    await proxy.close(); proxy = null;
    if (result.code !== 0) {
      const diagnostic = (text: string, size: number) => screenText(text, [...secrets, variables.proxyToken!])
        .replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted-url]").slice(-size);
      throw new Error(`Isolated agent failed (${result.code}): stdout=${diagnostic(result.stdout, 3000)} stderr=${diagnostic(result.stderr, 1000)}`);
    }
    // Read a single bounded regular file through a trusted image executable, never docker-cp or a host bind mount.
    const readResult = await execute("docker", ["exec", name, "/usr/local/bin/node", "--input-type=module", "-e",
      `import fs from 'node:fs'; const fd=fs.openSync('${SESSION}/report.json',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); const s=fs.fstatSync(fd); if(!s.isFile()||s.size>262144)process.exit(2); const b=Buffer.alloc(262145);const n=fs.readSync(fd,b,0,b.length,0);if(n>262144)process.exit(2); process.stdout.write(b.subarray(0,n));`]);
    await checked("docker", ["kill", name]);
    const report = investigationReportSchema.parse(normalizeAgentOutput(plan.engine, readResult.code === 0 ? readResult.stdout : result.stdout));
    // JSONL is executor telemetry, not independent proof that the untrusted executor's conclusions are correct.
    return { report, exitCode: result.code, stdout: "", stderr: "", workspaceChanges: [],
      observedCommands: parseObservedCommands(plan.engine, screenText(result.stdout, [...secrets, variables.proxyToken!])).slice(0, 100),
      reviewedEgressAudits: [] };
  } finally {
    try { if (proxy) await proxy.close(); }
    finally {
      try { if (containerCreated) await checked("docker", ["rm", "--force", name]); }
      finally {
        try { if (networkCreated) await checked("docker", ["network", "rm", name]); }
        finally { await rm(stage, { recursive: true, force: true }); }
      }
    }
  }
}
