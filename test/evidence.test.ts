import { describe, expect, it } from "vitest";
import type { DuplicateCandidate, InvestigationReport } from "../src/contracts";
import { normalizeEvidence } from "../src/evidence";
import { configSchema } from "../src/schema";

function report(overrides: Partial<InvestigationReport["assessment"]> = {}): InvestigationReport {
  return {
    schema_version: 1,
    issue: { repository: "example/project", number: 408, title: "Search fails", url: "https://github.com/example/project/issues/408" },
    agent: { engine: "codex", provider: "economical", model: "coder" },
    investigation: {
      status: "completed",
      summary: "Search failed for one reporter.",
      code_path_identified: true,
      test_attempted: false,
      environment_match: "mismatch",
    },
    reproduction: {
      status: "inconclusive",
      requested_probe: null,
      user_steps: [],
      proposed_steps: ["Search by title"],
      verified_steps: ["untrusted"],
    },
    evidence: {
      commands: [{ command: "claimed", exit_code: 0, observation: "claimed" }],
      code_locations: [],
      observations: ["The model says this is global"],
    },
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
      ...overrides,
    },
  };
}

const config = configSchema.parse({ investigation: { trigger: "always", engine: "codex" } });

describe("normalizeEvidence", () => {
  it("prevents an unreproduced report like #408 from becoming high priority", () => {
    const normalized = normalizeEvidence(report(), {
      config,
      duplicateCandidates: [],
      observedCommands: [],
      workspaceChanges: [],
    });
    expect(normalized.assessment.priority).toBe("medium");
    expect(normalized.assessment.needs_info).toBe(true);
    expect(normalized.assessment.confidence).toBe(0.7);
    expect(normalized.reproduction.verified_steps).toEqual([]);
    expect(normalized.evidence.commands).toEqual([]);
  });

  it("accepts only controller-provided duplicate targets", () => {
    const candidates: DuplicateCandidate[] = [{
      number: 123,
      title: "Same failure",
      state: "open",
      labels: ["bug"],
      url: "https://github.com/example/project/issues/123",
      bodySnippet: "same",
    }];
    const accepted = normalizeEvidence(report({ disposition: "duplicate", duplicate_of: 123 }), {
      config,
      duplicateCandidates: candidates,
      observedCommands: [],
      workspaceChanges: [],
    });
    expect(accepted.assessment.disposition).toBe("duplicate");
    expect(accepted.assessment.priority).toBe("none");

    const rejected = normalizeEvidence(report({ disposition: "duplicate", duplicate_of: 999 }), {
      config,
      duplicateCandidates: candidates,
      observedCommands: [],
      workspaceChanges: [],
    });
    expect(rejected.assessment.disposition).toBe("none");
    expect(rejected.assessment.duplicate_of).toBeNull();
  });
});
