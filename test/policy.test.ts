import { describe, expect, it } from "vitest";
import { shouldInvestigate } from "../src/policy";
import { configSchema } from "../src/schema";
import { issueFixture } from "./fixtures";

describe("shouldInvestigate", () => {
  it("matches labels case-insensitively", () => {
    const config = configSchema.parse({ investigation: { trigger: "label", triggerLabel: "ai-investigate" } });
    expect(shouldInvestigate({ ...issueFixture, labels: ["AI-Investigate"] }, config)).toBe(true);
  });

  it("can route only bug-labelled Issues to the expensive agent", () => {
    const config = configSchema.parse({ investigation: { trigger: "bugs", bugLabels: ["bug"] } });
    expect(shouldInvestigate({ ...issueFixture, labels: ["BUG"] }, config)).toBe(true);
    expect(shouldInvestigate({ ...issueFixture, labels: ["documentation"] }, config)).toBe(false);
  });
});
