import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "issue-investigator-fallback-smoke-"));

try {
  mkdirSync(path.join(temp, ".github"));
  const outputPath = path.join(temp, "github-output.txt");
  const eventPath = path.join(temp, "event.json");
  writeFileSync(outputPath, "");
  const report = {
    schema_version: 1,
    issue: { repository: "wrong/repo", number: 1, title: "wrong", url: "wrong" },
    agent: { engine: "custom", provider: null, model: null },
    investigation: { status: "completed", summary: "Fallback succeeded.", code_path_identified: true, test_attempted: false, environment_match: "unknown" },
    reproduction: { status: "not-attempted", requested_probe: null, user_steps: [], proposed_steps: [], verified_steps: [] },
    evidence: { commands: [], code_locations: [], observations: [] },
    assessment: {
      type: "question",
      disposition: "none",
      duplicate_of: null,
      priority: "low",
      risk_flags: [],
      needs_info: false,
      suggested_title: null,
      questions: [],
      confidence: 0.5,
      limitations: [],
    },
  };
  writeFileSync(path.join(temp, "mock-agent.mjs"), `process.stdout.write(${JSON.stringify(JSON.stringify(report))});`);
  writeFileSync(path.join(temp, ".github", "issue-investigator.yml"), [
    "schemaVersion: 1",
    "triage:",
    "  duplicateSearch: false",
    "providers:",
    "  primary:",
    "    model: primary-model",
    "    baseUrl: https://primary.invalid/v1",
    "    auth:",
    "      mode: environment",
    "      env: INTENTIONALLY_MISSING_KEY",
    "  fallback:",
    "    kind: local",
    "    model: fallback-model",
    "    baseUrl: http://127.0.0.1:9999/v1",
    "    auth:",
    "      mode: none",
    "investigation:",
    "  engine: custom",
    "  provider: primary",
    "  fallbackProviders: [fallback]",
    "  trigger: always",
    "  mode: execute",
    "  allowUnsafeCredentialInheritance: true",
    `  command: ${JSON.stringify(process.execPath)}`,
    '  argsPrefix: ["{workspace}/mock-agent.mjs"]',
  ].join("\n"));
  writeFileSync(eventPath, JSON.stringify({
    action: "opened",
    repository: { full_name: "example/project" },
    issue: { number: 408, title: "Question", body: "Details", html_url: "https://github.com/example/project/issues/408", user: { login: "reporter" }, labels: [] },
  }));

  const result = spawnSync(process.execPath, [path.join(root, "dist", "index.js")], {
    cwd: root,
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
  if (result.status !== 0) throw new Error(`Fallback smoke failed:\n${result.stdout}\n${result.stderr}`);
  const output = readFileSync(outputPath, "utf8");
  if (!output.includes('"provider":"fallback"') || !output.includes('"model":"fallback-model"')) {
    throw new Error(`Fallback provider was not bound into the final report:\n${output}`);
  }
  process.stdout.write("Bundled provider-fallback smoke test passed.\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
