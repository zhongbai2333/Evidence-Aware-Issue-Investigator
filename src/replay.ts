import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyDisposableWorkspace, type ObservedCommand } from "./runner";
import type { InvestigatorConfig } from "./schema";

const MAX_CAPTURE_BYTES = 1_000_000;

export interface ReplayResult {
  probe: string;
  verified: boolean;
  outcome: "reproduced" | "not-reproduced" | "inconclusive";
  verifiedSteps: string[];
  command: ObservedCommand;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const keys = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"];
  return Object.fromEntries(
    keys.map((key) => [key, process.env[key]]).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function execute(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  cleanupContainerName?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, { cwd, env: safeEnvironment(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
      if (cleanupContainerName) {
        spawnSync("docker", ["rm", "-f", cleanupContainerName], { env: safeEnvironment(), stdio: "ignore" });
      }
      reject(new Error(`Replay timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
  return { exitCode, stdout, stderr };
}

export async function runReplay(
  sourceWorkspace: string,
  probeName: string,
  config: InvestigatorConfig,
): Promise<ReplayResult> {
  const probe = config.replay.probes[probeName];
  if (!config.replay.enabled || !probe) {
    return {
      probe: probeName,
      verified: false,
      outcome: "inconclusive",
      verifiedSteps: [],
      command: { command: "", exitCode: null, observation: "Probe is not approved by controller configuration." },
    };
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "issue-replay-"));
  const workspace = path.join(tempDir, "workspace");
  try {
    await copyDisposableWorkspace(sourceWorkspace, workspace);
    let command: string;
    let args: string[];
    let cwd = workspace;
    let containerName: string | undefined;

    if (config.replay.executor === "container") {
      containerName = `issue-investigator-replay-${randomUUID()}`;
      command = "docker";
      args = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        "--network",
        probe.network ? "bridge" : "none",
        "--volume",
        `${workspace}:/workspace:rw`,
        "--workdir",
        "/workspace",
      ];
      if (typeof process.getuid === "function" && typeof process.getgid === "function") {
        args.push("--user", `${process.getuid()}:${process.getgid()}`);
      }
      args.push(config.replay.containerImage!, ...probe.command.map((value) => value.replaceAll("{workspace}", "/workspace")));
      cwd = tempDir;
    } else {
      const resolvedCommand = probe.command.map((value) => value.replaceAll("{workspace}", workspace));
      command = resolvedCommand[0]!;
      args = resolvedCommand.slice(1);
    }

    const executed = await execute(command, args, cwd, probe.timeoutMinutes * 60_000, containerName);
    const verified = probe.expectedExitCodes.includes(executed.exitCode);
    const observation = [executed.stdout, executed.stderr].filter(Boolean).join("\n").slice(0, 8000);
    return {
      probe: probeName,
      verified,
      outcome: verified ? probe.outcome : "inconclusive",
      verifiedSteps: verified ? probe.verifiedSteps : [],
      command: {
        command: JSON.stringify(probe.command),
        exitCode: executed.exitCode,
        observation,
      },
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
