import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReplay } from "../src/replay";
import { configSchema } from "../src/schema";

const tempDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PATH_BEFORE_REPLAY_TEST;
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runReplay", () => {
  it("promotes only a controller-approved probe executed on a fresh copy", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-replay-test-"));
    tempDirectories.push(workspace);
    await writeFile(
      path.join(workspace, "probe.mjs"),
      'process.stdout.write("reported failure reproduced"); process.exit(7);',
    );
    const config = configSchema.parse({
      replay: {
        enabled: true,
        executor: "host",
        allowUnsafeHostExecution: true,
        probes: {
          search_failure: {
            command: [process.execPath, "{workspace}/probe.mjs"],
            expectedExitCodes: [7],
            outcome: "reproduced",
            verifiedSteps: ["Run the approved search probe and observe exit code 7."],
          },
        },
      },
    });

    const result = await runReplay(workspace, "search_failure", config);
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe("reproduced");
    expect(result.command.exitCode).toBe(7);
    expect(result.verifiedSteps).toHaveLength(1);
  });

  it("does not execute an unknown agent-requested probe", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-replay-test-"));
    tempDirectories.push(workspace);
    const config = configSchema.parse({
      replay: {
        enabled: true,
        executor: "host",
        allowUnsafeHostExecution: true,
        probes: {
          approved: {
            command: [process.execPath, "--version"],
            verifiedSteps: ["Check runtime version."],
          },
        },
      },
    });
    const result = await runReplay(workspace, "attacker-command", config);
    expect(result.verified).toBe(false);
    expect(result.outcome).toBe("inconclusive");
  });

  it("constructs a hardened digest-pinned Docker replay", async () => {
    if (process.platform === "win32") return;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-replay-test-"));
    tempDirectories.push(workspace);
    const fakeBin = path.join(workspace, "fake-bin");
    await mkdir(fakeBin);
    const logPath = path.join(workspace, "docker-args.json");
    const dockerPath = path.join(fakeBin, "docker");
    await writeFile(
      dockerPath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await chmod(dockerPath, 0o755);
    const oldPath = process.env.PATH ?? "";
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath}`;
    try {
      const digest = "a".repeat(64);
      const config = configSchema.parse({
        replay: {
          enabled: true,
          executor: "container",
          containerImage: `example/test@sha256:${digest}`,
          probes: {
            approved: {
              command: ["./probe"],
              verifiedSteps: ["Run probe in hardened container."],
            },
          },
        },
      });
      const result = await runReplay(workspace, "approved", config);
      expect(result.verified).toBe(true);
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];
      expect(args).toEqual(expect.arrayContaining([
        "--cap-drop",
        "ALL",
        "no-new-privileges",
        "--network",
        "none",
        `example/test@sha256:${digest}`,
      ]));
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
