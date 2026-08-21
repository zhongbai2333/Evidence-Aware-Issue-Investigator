import { describe, expect, it } from "vitest";
import { investigationReportSchema } from "../src/report";

describe("investigation report schema", () => {
  it("rejects unsupported certainty and priority values", () => {
    const invalid = {
      schema_version: 1,
      issue: { repository: "a/b", number: 1, title: "x", url: "https://github.com/a/b/issues/1" },
      agent: { engine: "codex", provider: "cheap", model: "coder" },
      investigation: {
        status: "completed",
        summary: "done",
        code_path_identified: true,
        test_attempted: true,
        environment_match: "maybe",
      },
      reproduction: { status: "certainly-fixed", requested_probe: null, user_steps: [], proposed_steps: [], verified_steps: [] },
      evidence: { commands: [], code_locations: [], observations: [] },
      assessment: {
        type: "bug",
        disposition: "none",
        duplicate_of: null,
        priority: "urgent",
        risk_flags: [],
        needs_info: false,
        suggested_title: null,
        questions: [],
        confidence: 2,
        limitations: [],
      },
    };
    expect(() => investigationReportSchema.parse(invalid)).toThrow();
  });
});
