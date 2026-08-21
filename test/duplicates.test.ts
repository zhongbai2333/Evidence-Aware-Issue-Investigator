import { describe, expect, it, vi } from "vitest";
import { searchDuplicateCandidates } from "../src/duplicates";
import { issueFixture } from "./fixtures";

describe("duplicate candidate retrieval", () => {
  it("uses sanitized bounded GitHub search terms and excludes the current Issue", async () => {
    const search = vi.fn().mockResolvedValue({
      data: {
        items: [
          { number: 408, title: "current", state: "open", labels: [], html_url: "current", body: "current" },
          { number: 123, title: "Search also fails", state: "open", labels: [{ name: "bug" }], html_url: "candidate", body: "same symptom" },
        ],
      },
    });
    const octokit = { rest: { search: { issuesAndPullRequests: search } } };
    const candidates = await searchDuplicateCandidates(octokit as never, {
      ...issueFixture,
      title: "Search is:pr repo:attacker/private fails",
    }, 8);
    const query = search.mock.calls[0]?.[0]?.q as string;
    expect(query).toContain("repo:example/project is:issue");
    expect(query).not.toContain("repo:attacker/private");
    expect(query).not.toContain("is:pr");
    expect(candidates.map((candidate) => candidate.number)).toEqual([123]);
  });
});
