import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPullRequestIssueEvent } from "../src/event";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("event preflight", () => {
  it("distinguishes pull request comments from real Issue comments", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "investigator-event-"));
    tempDirectories.push(directory);
    const eventPath = path.join(directory, "event.json");
    await writeFile(eventPath, JSON.stringify({ issue: { number: 1, pull_request: { url: "pr" } } }));
    expect(await isPullRequestIssueEvent(eventPath)).toBe(true);
    await writeFile(eventPath, JSON.stringify({ issue: { number: 1 } }));
    expect(await isPullRequestIssueEvent(eventPath)).toBe(false);
  });
});
