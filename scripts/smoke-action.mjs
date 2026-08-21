import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "issue-investigator-smoke-"));

try {
  mkdirSync(path.join(temp, ".github"));
  const configPath = path.join(temp, ".github", "issue-investigator.yml");
  const eventPath = path.join(temp, "event.json");
  const outputPath = path.join(temp, "github-output.txt");
  writeFileSync(outputPath, "");

  writeFileSync(
    configPath,
    [
      "schemaVersion: 1",
      "providers:",
      "  company:",
      "    kind: enterprise",
      "    model: secure-coder",
      "    baseUrl: https://llm.corp.example/v1",
      "investigation:",
      "  engine: codex",
      "  provider: company",
      "  trigger: always",
      "  mode: plan",
    ].join("\n"),
  );
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: "opened",
      repository: { full_name: "example/project" },
      issue: {
        number: 408,
        title: "Search fails by title",
        body: "Search returns an opaque error.",
        html_url: "https://github.com/example/project/issues/408",
        user: { login: "reporter" },
        labels: [{ name: "BUG" }],
      },
    }),
  );

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
    },
  });

  if (result.status !== 0) {
    throw new Error(`Bundled Action failed:\n${result.stdout}\n${result.stderr}`);
  }
  const output = readFileSync(outputPath, "utf8");
  if (!output.includes("investigation-status") || !output.includes("planned")) {
    throw new Error(`Bundled Action did not emit the planned result:\n${output}`);
  }
  process.stdout.write("Bundled Action smoke test passed.\n");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
