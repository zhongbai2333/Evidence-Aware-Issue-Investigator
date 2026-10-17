import { describe, expect, it, vi } from "vitest";
import type { InvestigationReport } from "../src/contracts";
import { renderReportComment } from "../src/render";
import { publishReportComment } from "../src/publish";

const report: InvestigationReport = {
  schema_version: 1,
  issue: { repository: "example/project", number: 408, title: "Search fails", url: "https://github.com/example/project/issues/408" },
  agent: { engine: "codex", provider: "secure", model: "coder" },
  investigation: { status: "completed", summary: "Investigated.", code_path_identified: true, test_attempted: true, environment_match: "partial" },
  reproduction: { status: "inconclusive", requested_probe: null, user_steps: [], proposed_steps: [], verified_steps: [] },
  evidence: { commands: [], code_locations: [], observations: [] },
  assessment: {
    type: "bug",
    disposition: "none",
    duplicate_of: null,
    priority: "medium",
    risk_flags: [],
    needs_info: true,
    suggested_title: "[BUG] Search fails",
    questions: ["Does it also fail on another network?"],
    confidence: 0.6,
    limitations: [],
  },
};

function client() {
  const bot = { type: "Bot", login: "github-actions[bot]" };
  const other = structuredClone(report);
  other.issue.number++;
  const comments = [
    { id: 1, body: renderReportComment(report), user: bot },
    { id: 2, body: renderReportComment(report), user: { type: "User", login: "maintainer" } },
    { id: 3, body: renderReportComment(report), user: { type: "Bot", login: "another[bot]" } },
    { id: 4, body: renderReportComment(other), user: bot },
    { id: 5, body: "<!-- evidence-aware-issue-investigator --> invalid report", user: bot },
    { id: 6, body: renderReportComment(report), user: bot },
  ];
  const calls: string[] = [];
  const issues = {
    listComments: vi.fn(),
    createComment: vi.fn(async () => { calls.push("create"); return { data: { id: 7 } }; }),
    deleteComment: vi.fn(async ({ comment_id }: { comment_id: number }) => { calls.push(`delete:${comment_id}`); return {}; }),
  };
  return { rest: { issues }, paginate: vi.fn().mockResolvedValue(comments), calls };
}

describe("report comment replacement", () => {
  it("creates before deleting only previous valid reports owned by the expected bot", async () => {
    const octokit = client();
    await publishReportComment(octokit as never, report, vi.fn());
    expect(octokit.calls).toEqual(["create", "delete:1", "delete:6"]);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 408, body: renderReportComment(report) }));
  });

  it("retains every previous report if publication fails", async () => {
    const octokit = client();
    octokit.rest.issues.createComment.mockRejectedValue(new Error("unavailable"));
    await expect(publishReportComment(octokit as never, report, vi.fn())).rejects.toThrow("unavailable");
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it("keeps the new report and continues cleanup after a deletion failure", async () => {
    const octokit = client();
    const warn = vi.fn();
    octokit.rest.issues.deleteComment.mockRejectedValueOnce({ status: 403 });
    await publishReportComment(octokit as never, report, warn);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores an already removed previous report", async () => {
    const octokit = client();
    const warn = vi.fn();
    octokit.rest.issues.deleteComment.mockRejectedValueOnce({ status: 404 });
    await publishReportComment(octokit as never, report, warn);
    expect(warn).not.toHaveBeenCalled();
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledTimes(2);
  });
});
