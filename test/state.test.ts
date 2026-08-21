import { describe, expect, it, vi } from "vitest";
import type { IssueEventContext } from "../src/event";
import { renderReportComment } from "../src/render";
import { configSchema } from "../src/schema";
import { handleStateEvent } from "../src/state";
import type { InvestigationReport } from "../src/contracts";

function report(): InvestigationReport {
  return {
    schema_version: 1,
    issue: { repository: "example/project", number: 408, title: "Search fails", url: "https://github.com/example/project/issues/408" },
    agent: { engine: "codex", provider: "secure", model: "coder" },
    investigation: { status: "completed", summary: "Investigated.", code_path_identified: true, test_attempted: true, environment_match: "exact" },
    reproduction: { status: "reproduced", requested_probe: "search", user_steps: [], proposed_steps: [], verified_steps: ["verified"] },
    evidence: { commands: [], code_locations: [], observations: [] },
    assessment: {
      type: "bug",
      disposition: "none",
      duplicate_of: null,
      priority: "high",
      risk_flags: [],
      needs_info: false,
      suggested_title: "[BUG] Search fails",
      questions: [],
      confidence: 0.9,
      limitations: [],
    },
  };
}

function event(overrides: Partial<IssueEventContext> = {}): IssueEventContext {
  return {
    issue: {
      repository: "example/project",
      number: 408,
      title: "Search fails",
      body: "fails",
      author: "reporter",
      labels: ["Confirm", "Needs-Info"],
      url: "https://github.com/example/project/issues/408",
    },
    eventName: "issues",
    action: "labeled",
    sender: "maintainer",
    label: "Confirm",
    commentBody: null,
    commentAuthor: null,
    ...overrides,
  };
}

function mockOctokit() {
  const listComments = vi.fn();
  const listLabelsForRepo = vi.fn();
  const rest = {
    repos: { getCollaboratorPermissionLevel: vi.fn().mockResolvedValue({ data: { permission: "admin" } }) },
    issues: {
      listComments,
      listLabelsForRepo,
      removeLabel: vi.fn().mockResolvedValue({}),
      createLabel: vi.fn().mockResolvedValue({}),
      addLabels: vi.fn().mockResolvedValue({}),
      addAssignees: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      createComment: vi.fn().mockResolvedValue({}),
    },
  };
  const paginate = vi.fn(async (method: unknown) => {
    if (method === listComments) {
      return [{
        id: 1,
        body: renderReportComment(report()),
        user: { type: "Bot", login: "github-actions[bot]" },
      }];
    }
    if (method === listLabelsForRepo) return [];
    return [];
  });
  return { rest, paginate };
}

describe("GitHub state machine", () => {
  it("applies a bound report only after a maintainer confirmation", async () => {
    const octokit = mockOctokit();
    const config = configSchema.parse({ mutation: { mode: "maintainer-confirm" } });
    const operation = await handleStateEvent(octokit as never, event(), config);
    expect(operation).toBe("confirm");
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({
      labels: expect.arrayContaining(["BUG", "priority: high"]),
    }));
    expect(octokit.rest.issues.addAssignees).toHaveBeenCalled();
    expect(octokit.rest.issues.update).not.toHaveBeenCalled();
  });

  it("turns an Issue-author follow-up under Needs-Info into one rerun label", async () => {
    const octokit = mockOctokit();
    const config = configSchema.parse({ mutation: { mode: "maintainer-confirm" } });
    const operation = await handleStateEvent(octokit as never, event({
      eventName: "issue_comment",
      action: "created",
      sender: "reporter",
      label: null,
      commentAuthor: "reporter",
      commentBody: "More details",
    }), config);
    expect(operation).toBe("followup-rerun");
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["AI-Rerun"] }));
  });

  it("removes Confirm without applying a report when the actor lacks maintainer permission", async () => {
    const octokit = mockOctokit();
    octokit.rest.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce({ data: { permission: "read" } });
    const config = configSchema.parse({ mutation: { mode: "maintainer-confirm" } });
    const operation = await handleStateEvent(octokit as never, event(), config);
    expect(operation).toBe("confirm");
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "Confirm" }));
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).toHaveBeenCalled();
  });
});
