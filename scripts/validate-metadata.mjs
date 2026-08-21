import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";

const action = yaml.load(readFileSync("action.yml", "utf8"));
if (!action || typeof action !== "object") throw new Error("action.yml must contain an object");
if (action.runs?.using !== "node24") throw new Error("action.yml must use Node 24");
if (action.runs?.main !== "dist/index.js" || !existsSync(action.runs.main)) {
  throw new Error("action.yml must reference the bundled dist/index.js");
}
for (const required of ["github-token", "config-path", "publish-comment", "agent-engine", "provider", "model", "execution-mode"]) {
  if (!action.inputs?.[required]) throw new Error(`Missing Action input: ${required}`);
}
for (const required of ["report-json", "investigation-status", "agent-engine", "provider", "operation"]) {
  if (!action.outputs?.[required]) throw new Error(`Missing Action output: ${required}`);
}

for (const workflowPath of [
  ".github/workflows/ci.yml",
  ".github/workflows/dogfood.yml",
  ".github/workflows/release.yml",
  "examples/workflow.yml",
]) {
  const workflow = yaml.load(readFileSync(workflowPath, "utf8"));
  if (!workflow || typeof workflow !== "object") throw new Error(`Invalid workflow YAML: ${workflowPath}`);
}

const dogfoodConfig = yaml.load(readFileSync(".github/issue-investigator.yml", "utf8"));
if (!dogfoodConfig || typeof dogfoodConfig !== "object") throw new Error("Invalid dogfood configuration YAML");

process.stdout.write("Action metadata and workflow YAML validation passed.\n");
