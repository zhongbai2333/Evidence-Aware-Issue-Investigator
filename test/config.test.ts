import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRuntimeOverrides, loadConfig } from "../src/config";
import { configSchema } from "../src/schema";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runtime model switching", () => {
  it("switches engine, provider, model, and execution mode through validated overrides", () => {
    const base = configSchema.parse({
      providers: {
        cheap: { model: "cheap-coder", baseUrl: "https://cheap.example/v1" },
        secure: { kind: "enterprise", model: "secure-coder", baseUrl: "https://corp.example/v1" },
      },
      investigation: { engine: "codex", provider: "cheap" },
    });
    const switched = applyRuntimeOverrides(base, {
      engine: "codex",
      provider: "secure",
      model: "secure-coder-v2",
      mode: "execute",
    });
    expect(switched.investigation.provider).toBe("secure");
    expect(switched.providers.secure?.model).toBe("secure-coder-v2");
    expect(switched.providers.cheap?.model).toBe("cheap-coder");
    expect(switched.investigation.mode).toBe("execute");
  });
});

describe("loadConfig", () => {
  it("validates the repository dogfood configuration", async () => {
    const config = await loadConfig(process.cwd(), ".github/issue-investigator.yml");
    expect(config.investigation.engine).toBe("dsh");
    expect(config.investigation.mode).toBe("execute");
    expect(config.providers.deepseek?.protocol).toBe("chat-completions");
  });

  it("loads named providers and applies safe defaults", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-config-"));
    tempDirectories.push(workspace);
    await mkdir(path.join(workspace, ".github"));
    await writeFile(
      path.join(workspace, ".github", "issue-investigator.yml"),
      [
        "schemaVersion: 1",
        "providers:",
        "  economical:",
        "    model: coder-small",
        "    baseUrl: https://gateway.example/v1",
        "investigation:",
        "  engine: codex",
        "  provider: economical",
        "  trigger: bugs",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(workspace, ".github/issue-investigator.yml");
    expect(config.investigation.mode).toBe("plan");
    expect(config.investigation.provider).toBe("economical");
    expect(config.providers.economical?.model).toBe("coder-small");
    expect(config.providers.economical?.protocol).toBe("responses");
  });

  it("rejects paths outside the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-config-"));
    tempDirectories.push(workspace);
    await expect(loadConfig(workspace, "../secrets.yml")).rejects.toThrow("escapes the workspace");
  });
});
