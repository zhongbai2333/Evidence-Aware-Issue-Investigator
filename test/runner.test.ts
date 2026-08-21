import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInvocationPlan } from "../src/contracts";
import { runAgent } from "../src/runner";

const tempDirectories: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.TEST_PROVIDER_KEY;
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function validReport(): object {
  return {
    schema_version: 1,
    issue: { repository: "example/project", number: 408, title: "Search fails", url: "https://github.com/example/project/issues/408" },
    agent: { engine: "custom", provider: null, model: null },
    investigation: {
      status: "completed",
      summary: "Mock investigation completed.",
      code_path_identified: true,
      test_attempted: true,
      environment_match: "partial",
    },
    reproduction: { status: "inconclusive", requested_probe: null, user_steps: [], proposed_steps: [], verified_steps: [] },
    evidence: { commands: [{ command: "untrusted claim", exit_code: 0, observation: "claimed" }], code_locations: [], observations: [] },
    assessment: {
      type: "bug",
      disposition: "none",
      duplicate_of: null,
      priority: "medium",
      risk_flags: [],
      needs_info: true,
      suggested_title: "[BUG] Search fails",
      questions: ["Provide the complete error chain."],
      confidence: 0.6,
      limitations: [],
    },
  };
}

function customPlan(workspace: string): AgentInvocationPlan {
  return {
    engine: "custom",
    provider: null,
    model: null,
    command: process.execPath,
    args: ["{workspace}/mock-agent.mjs"],
    cwd: workspace,
    environment: {},
    generatedFiles: {},
    outputFormat: "json",
    timeoutMs: 10_000,
    versionCheck: null,
    credentialProxy: null,
  };
}

describe("runAgent", () => {
  it("runs in a filtered disposable workspace and reports controller-observed changes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-runner-"));
    tempDirectories.push(workspace);
    await mkdir(path.join(workspace, ".git"));
    await writeFile(path.join(workspace, ".git", "config"), "credential=secret");
    await writeFile(path.join(workspace, ".env"), "SECRET=value");
    await writeFile(path.join(workspace, "source.txt"), "baseline");
    await writeFile(
      path.join(workspace, "mock-agent.mjs"),
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'if (existsSync(".git") || existsSync(".env")) throw new Error("sensitive files copied");',
        'if (process.env.GITHUB_TOKEN) throw new Error("controller token leaked");',
        'writeFileSync("source.txt", "changed");',
        'writeFileSync("reproduction.txt", "candidate");',
        `process.stdout.write(${JSON.stringify(JSON.stringify(validReport()))});`,
      ].join("\n"),
    );
    process.env.GITHUB_TOKEN = "must-not-leak";

    const result = await runAgent(customPlan(workspace));
    expect(result.report.investigation.status).toBe("completed");
    expect(result.workspaceChanges).toEqual(expect.arrayContaining([
      { path: "source.txt", kind: "modified" },
      { path: "reproduction.txt", kind: "added" },
    ]));
    expect(result.observedCommands).toEqual([]);
  });

  it("derives Codex command evidence from controller-captured JSONL events", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-runner-"));
    tempDirectories.push(workspace);
    await writeFile(
      path.join(workspace, "mock-codex.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(process.argv[2], ${JSON.stringify(JSON.stringify(validReport()))});`,
        'process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"command_execution",command:"cargo test",exit_code:0,aggregated_output:"12 passed"}})+"\\n");',
      ].join("\n"),
    );
    const plan = customPlan(workspace);
    plan.engine = "codex";
    plan.args = ["{workspace}/mock-codex.mjs", "{outputPath}"];
    plan.outputFormat = "jsonl";
    const result = await runAgent(plan);
    expect(result.observedCommands).toEqual([{ command: "cargo test", exitCode: 0, observation: "12 passed" }]);
  });

  it("gives the agent only an ephemeral proxy token while the upstream receives the real key", async () => {
    let upstreamAuthorization = "";
    const upstream = http.createServer((request, response) => {
      upstreamAuthorization = String(request.headers.authorization ?? "");
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not bind");

    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-runner-"));
    tempDirectories.push(workspace);
    await writeFile(
      path.join(workspace, "mock-agent.mjs"),
      [
        'if (process.env.TEST_PROVIDER_KEY) throw new Error("real key leaked");',
        'const response = await fetch(process.env.TEST_BASE_URL+"/v1/responses", {method:"POST",headers:{authorization:"Bearer "+process.env.TEST_PROXY_TOKEN,"content-type":"application/json"},body:"{}"});',
        'if (!response.ok) throw new Error("proxy request failed "+response.status);',
        `process.stdout.write(${JSON.stringify(JSON.stringify(validReport()))});`,
      ].join("\n"),
    );
    process.env.TEST_PROVIDER_KEY = "real-secret";
    const plan = customPlan(workspace);
    plan.environment = {
      TEST_BASE_URL: { value: "{proxyBaseUrl}", sensitive: false },
      TEST_PROXY_TOKEN: { value: "{proxyToken}", sensitive: true },
    };
    plan.credentialProxy = {
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      sourceEnv: "TEST_PROVIDER_KEY",
      protocol: "responses",
      maxRequests: 5,
      headersFromEnv: {},
    };
    await runAgent(plan);
    expect(upstreamAuthorization).toBe("Bearer real-secret");
  });

  it("rejects repository symlinks that escape the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "investigator-runner-"));
    tempDirectories.push(workspace);
    await writeFile(path.join(workspace, "mock-agent.mjs"), "");
    await symlink("../outside", path.join(workspace, "escape"));
    await expect(runAgent(customPlan(workspace))).rejects.toThrow("symlink escapes");
  });
});
