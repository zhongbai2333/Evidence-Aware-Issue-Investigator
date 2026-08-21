import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "issue-investigator-execute-smoke-"));

try {
  mkdirSync(path.join(temp, ".github"));
  const outputPath = path.join(temp, "github-output.txt");
  const eventPath = path.join(temp, "event.json");
  writeFileSync(outputPath, "");
  writeFileSync(path.join(temp, "baseline.txt"), "unchanged");
  const report = {
    schema_version: 1,
    issue: { repository: "untrusted/wrong", number: 999, title: "wrong", url: "wrong" },
    agent: { engine: "custom", provider: null, model: null },
    investigation: { status: "completed", summary: "Mock code-aware investigation.", code_path_identified: true, test_attempted: true, environment_match: "mismatch" },
    reproduction: { status: "inconclusive", requested_probe: null, user_steps: ["Search"], proposed_steps: ["Retry on another network"], verified_steps: ["untrusted"] },
    evidence: { commands: [{ command: "claimed", exit_code: 0, observation: "claimed" }], code_locations: [], observations: [] },
    assessment: {
      type: "bug",
      disposition: "none",
      duplicate_of: null,
      priority: "high",
      risk_flags: [],
      needs_info: false,
      suggested_title: "[BUG] Search fails",
      questions: [],
      confidence: 0.95,
      limitations: [],
    },
  };
  writeFileSync(
    path.join(temp, "mock-agent.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("baseline.txt", "agent changed disposable copy");',
      'writeFileSync("agent-only.txt", "must not escape");',
      `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`,
    ].join("\n"),
  );
  writeFileSync(
    path.join(temp, ".github", "issue-investigator.yml"),
    [
      "schemaVersion: 1",
      "triage:",
      "  duplicateSearch: false",
      "investigation:",
      "  engine: custom",
      "  trigger: always",
      "  mode: execute",
      `  command: ${JSON.stringify(process.execPath)}`,
      '  argsPrefix: ["{workspace}/mock-agent.mjs"]',
    ].join("\n"),
  );
  writeFileSync(eventPath, JSON.stringify({
    action: "opened",
    repository: { full_name: "example/project" },
    issue: {
      number: 408,
      title: "Search fails",
      body: "Opaque failure",
      html_url: "https://github.com/example/project/issues/408",
      user: { login: "reporter" },
      labels: [],
    },
  }));

  const result = spawnSync(process.execPath, [path.join(repositoryRoot, "dist", "index.js")], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: temp,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "issues",
      GITHUB_OUTPUT: outputPath,
      "INPUT_CONFIG-PATH": ".github/issue-investigator.yml",
      "INPUT_PUBLISH-COMMENT": "false",
      "INPUT_GITHUB-TOKEN": "",
      "INPUT_AGENT-ENGINE": "",
      "INPUT_PROVIDER": "",
      "INPUT_MODEL": "",
      "INPUT_EXECUTION-MODE": "",
    },
  });
  if (result.status !== 0) throw new Error(`Execute smoke failed:\n${result.stdout}\n${result.stderr}`);
  const output = readFileSync(outputPath, "utf8");
  if (!output.includes("completed") || !output.includes('"priority":"medium"')) {
    throw new Error(`Execute smoke did not normalize the report:\n${output}`);
  }
  if (readFileSync(path.join(temp, "baseline.txt"), "utf8") !== "unchanged" || existsSync(path.join(temp, "agent-only.txt"))) {
    throw new Error("Agent mutations escaped the disposable workspace");
  }
  process.stdout.write("Bundled execute-mode smoke test passed.\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
