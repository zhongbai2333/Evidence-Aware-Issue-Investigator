import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentInvocationPlan } from "./contracts";
import { investigationReportSchema, type ValidatedInvestigationReport } from "./report";
import type { InvestigatorConfig, ProviderConfig } from "./schema";
import { REPORT_JSON_SCHEMA } from "./schema";
import { startCredentialProxy, type CredentialProxyHandle } from "./proxy";

const MAX_CAPTURE_BYTES = 1_000_000;
const EXCLUDED_ROOT_NAMES = new Set([".git", ".env", ".DS_Store"]);

export interface WorkspaceChange {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export interface ObservedCommand {
  command: string;
  exitCode: number | null;
  observation: string;
}

function shouldExcludeWorkspacePath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const rootName = normalized.split("/")[0] ?? "";
  const baseName = path.posix.basename(normalized);
  return (
    EXCLUDED_ROOT_NAMES.has(rootName) ||
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    baseName.endsWith(".pem") ||
    baseName.endsWith(".key")
  );
}

async function assertSafeSymlinks(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (shouldExcludeWorkspacePath(relative)) continue;
    if (entry.isDirectory()) {
      await assertSafeSymlinks(root, absolute);
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(absolute);
      const resolved = path.resolve(path.dirname(absolute), target);
      const resolvedRelative = path.relative(root, resolved);
      if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
        throw new Error(`Workspace symlink escapes the repository: ${relative} -> ${target}`);
      }
    }
  }
}

export async function copyDisposableWorkspace(source: string, destination: string): Promise<void> {
  await assertSafeSymlinks(source);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const relative = path.relative(source, sourcePath);
      return !relative || !shouldExcludeWorkspacePath(relative);
    },
  });
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function collectWorkspaceManifest(root: string, current = root): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      await collectWorkspaceManifest(root, absolute).then((child) => {
        for (const item of child) manifest.set(...item);
      });
    } else if (entry.isSymbolicLink()) {
      manifest.set(relative, `symlink:${await readlink(absolute)}`);
    } else if (entry.isFile()) {
      manifest.set(relative, await hashFile(absolute));
    }
  }
  return manifest;
}

function compareManifests(before: Map<string, string>, after: Map<string, string>): WorkspaceChange[] {
  const changes: WorkspaceChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const filePath of [...paths].sort()) {
    if (!before.has(filePath)) changes.push({ path: filePath, kind: "added" });
    else if (!after.has(filePath)) changes.push({ path: filePath, kind: "deleted" });
    else if (before.get(filePath) !== after.get(filePath)) changes.push({ path: filePath, kind: "modified" });
  }
  return changes;
}

function safeBaseEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ];
  return Object.fromEntries(
    allowed
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function substitute(value: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce(
    (current, [key, replacement]) => current.replaceAll(`{${key}}`, replacement),
    value,
  );
}

function assertGeneratedPath(tempDir: string, relativePath: string): string {
  const absolute = path.resolve(tempDir, relativePath);
  const relative = path.relative(tempDir, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Generated file escapes temporary directory: ${relativePath}`);
  }
  return absolute;
}

export function assertExecutionSafety(
  config: InvestigatorConfig,
  provider: ProviderConfig | null,
): void {
  if (config.investigation.mode !== "execute") return;
  if (
    provider?.auth.mode === "environment" &&
    config.investigation.engine === "custom" &&
    !config.investigation.allowUnsafeCredentialInheritance
  ) {
    throw new Error(
      "Direct environment credentials are blocked for this engine because agent-spawned tools may inherit them. " +
        "Use a credential proxy/external helper, keep mode=plan, or explicitly accept the risk.",
    );
  }
}

function parseJsonCandidate(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("The agent returned no structured result");
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first < 0 || last <= first) throw new Error("The agent result is not JSON");
    return JSON.parse(trimmed.slice(first, last + 1));
  }
}

function normalizeAgentOutput(engine: AgentInvocationPlan["engine"], raw: string): unknown {
  const parsed = parseJsonCandidate(raw);
  if (engine === "claude" && parsed && typeof parsed === "object") {
    const envelope = parsed as { structured_output?: unknown; result?: unknown };
    return envelope.structured_output ?? envelope.result ?? envelope;
  }
  return parsed;
}

export interface AgentRunResult {
  report: ValidatedInvestigationReport;
  exitCode: number;
  stdout: string;
  stderr: string;
  workspaceChanges: WorkspaceChange[];
  observedCommands: ObservedCommand[];
}

async function verifyCliVersion(
  check: NonNullable<AgentInvocationPlan["versionCheck"]>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const child = spawn(check.command, check.args, { cwd, env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("CLI version check timed out"));
    }, 300_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
  if (exitCode !== 0) throw new Error(`CLI version check failed for ${check.command}: ${output.slice(-2000)}`);
  if (check.expectedVersion && !output.includes(check.expectedVersion)) {
    throw new Error(`CLI version mismatch: expected ${check.expectedVersion}, got ${output.trim() || "unknown"}`);
  }
}

function parseObservedCommands(engine: AgentInvocationPlan["engine"], stdout: string): ObservedCommand[] {
  if (engine !== "codex") return [];
  const commands: ObservedCommand[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        item?: {
          type?: string;
          command?: string;
          exit_code?: number | null;
          aggregated_output?: string;
          status?: string;
        };
      };
      if (event.type !== "item.completed" || event.item?.type !== "command_execution" || !event.item.command) continue;
      commands.push({
        command: event.item.command,
        exitCode: Number.isInteger(event.item.exit_code) ? event.item.exit_code! : null,
        observation: String(event.item.aggregated_output ?? event.item.status ?? "").slice(0, 4000),
      });
    } catch {
      // Non-JSON progress output is untrusted diagnostic data and is ignored.
    }
  }
  return commands;
}

export async function runAgent(plan: AgentInvocationPlan): Promise<AgentRunResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "issue-investigator-"));
  const schemaPath = path.join(tempDir, "report.schema.json");
  const outputPath = path.join(tempDir, "report.json");
  const agentWorkspace = path.join(tempDir, "workspace");
  let proxy: CredentialProxyHandle | null = null;

  try {
    if (plan.credentialProxy) proxy = await startCredentialProxy(plan.credentialProxy);
    const variables = {
      tempDir,
      schemaPath,
      outputPath,
      workspace: agentWorkspace,
      proxyBaseUrl: proxy?.baseUrl ?? "",
      proxyToken: proxy?.token ?? "",
    };
    await copyDisposableWorkspace(plan.cwd, agentWorkspace);
    const beforeManifest = await collectWorkspaceManifest(agentWorkspace);
    const isolatedHome = path.join(tempDir, "home");
    await mkdir(isolatedHome, { recursive: true });
    await writeFile(schemaPath, `${JSON.stringify(REPORT_JSON_SCHEMA, null, 2)}\n`, "utf8");
    for (const [relativePath, content] of Object.entries(plan.generatedFiles)) {
      const absolutePath = assertGeneratedPath(tempDir, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, substitute(content, variables), "utf8");
    }

    const environment = safeBaseEnvironment();
    environment.HOME = isolatedHome;
    environment.USERPROFILE = isolatedHome;
    if (plan.versionCheck) await verifyCliVersion(plan.versionCheck, environment, plan.cwd);
    for (const [target, source] of Object.entries(plan.environment)) {
      if (source.fromEnv) {
        if (["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].includes(source.fromEnv)) {
          throw new Error(`Protected controller credential cannot be forwarded to the agent: ${source.fromEnv}`);
        }
        const value = process.env[source.fromEnv];
        if (!value) throw new Error(`Required credential environment variable is missing: ${source.fromEnv}`);
        environment[target] = value;
      } else if (source.value !== undefined) {
        environment[target] = substitute(source.value, variables);
      }
    }

    const args = plan.args.map((arg) => substitute(arg, variables));
    const child = spawn(plan.command, args, {
      cwd: agentWorkspace,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8");
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Agent timed out after ${plan.timeoutMs}ms`));
      }, plan.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`Agent exited with code ${exitCode}: ${stderr.slice(-2000)}`);
    }

    let resultText = stdout;
    try {
      resultText = await readFile(outputPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const report = investigationReportSchema.parse(normalizeAgentOutput(plan.engine, resultText));
    const afterManifest = await collectWorkspaceManifest(agentWorkspace);
    return {
      report,
      exitCode,
      stdout,
      stderr,
      workspaceChanges: compareManifests(beforeManifest, afterManifest),
      observedCommands: parseObservedCommands(plan.engine, stdout),
    };
  } finally {
    if (proxy) await proxy.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
