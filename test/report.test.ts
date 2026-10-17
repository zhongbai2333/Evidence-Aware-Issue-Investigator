import { describe, expect, it } from "vitest";
import { investigationReportSchema } from "../src/report";
import { REPORT_JSON_SCHEMA } from "../src/schema";

function expectExplicitSchemaTypes(node: unknown, path = "$"): void {
  expect(node, `${path} must be a schema object`).toBeTypeOf("object");
  const schema = node as Record<string, unknown>;
  expect(
    "type" in schema || "anyOf" in schema || "$ref" in schema,
    `${path} must declare type, anyOf, or $ref`,
  ).toBe(true);
  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, child] of Object.entries(schema.properties as Record<string, unknown>)) {
      expectExplicitSchemaTypes(child, `${path}.properties.${name}`);
    }
  }
  if (schema.items && typeof schema.items === "object") {
    expectExplicitSchemaTypes(schema.items, `${path}.items`);
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((child, index) => expectExplicitSchemaTypes(child, `${path}.anyOf[${index}]`));
  }
}

describe("investigation report schema", () => {
  it("uses explicit types accepted by strict Responses API schema validators", () => {
    expectExplicitSchemaTypes(REPORT_JSON_SCHEMA);
  });

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
