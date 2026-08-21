import { describe, expect, it } from "vitest";
import type { InvestigationReport } from "../src/contracts";
import { parseReportMarker, renderReportComment } from "../src/render";

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

describe("report marker", () => {
  it("round-trips a validated machine-readable report", () => {
    const body = renderReportComment(report);
    expect(parseReportMarker(body)).toEqual(report);
  });

  it("rejects a forged invalid payload", () => {
    const marker = `<!-- evidence-aware-issue-investigator-report:v1:${Buffer.from('{"priority":"critical"}').toString("base64url")} -->`;
    expect(parseReportMarker(marker)).toBeNull();
  });
});
