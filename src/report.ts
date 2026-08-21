import { z } from "zod";

const shortText = z.string().max(1000);

export const investigationReportSchema = z.object({
  schema_version: z.literal(1),
  issue: z.object({
    repository: z.string().max(300),
    number: z.number().int().positive(),
    title: z.string().max(500),
    url: z.string().max(2000),
  }),
  agent: z.object({
    engine: z.enum(["none", "codex", "claude", "dsh", "custom"]),
    provider: z.string().max(200).nullable(),
    model: z.string().max(300).nullable(),
  }),
  investigation: z.object({
    status: z.enum(["planned", "completed", "failed", "skipped"]),
    summary: z.string().max(4000),
    code_path_identified: z.boolean(),
    test_attempted: z.boolean(),
    environment_match: z.enum(["exact", "partial", "mismatch", "unknown"]),
  }),
  reproduction: z.object({
    status: z.enum(["reproduced", "not-reproduced", "inconclusive", "not-attempted"]),
    requested_probe: z.string().max(100).nullable(),
    user_steps: z.array(shortText).max(20),
    proposed_steps: z.array(shortText).max(20),
    verified_steps: z.array(shortText).max(20),
  }),
  evidence: z.object({
    commands: z.array(
      z.object({
        command: z.string().max(2000),
        exit_code: z.number().int().nullable(),
        observation: z.string().max(4000),
      }),
    ).max(100),
    code_locations: z.array(
      z.object({
        path: z.string().max(1000),
        line: z.number().int().positive().nullable(),
        relevance: shortText,
      }),
    ).max(100),
    observations: z.array(shortText).max(100),
  }),
  assessment: z.object({
    type: z.enum(["bug", "enhancement", "documentation", "question", "unknown"]),
    disposition: z.enum(["none", "duplicate", "wontfix", "invalid"]),
    duplicate_of: z.number().int().positive().nullable(),
    priority: z.enum(["critical", "high", "medium", "low", "none"]),
    risk_flags: z.array(z.enum(["security", "data-loss", "complete-outage"])),
    needs_info: z.boolean(),
    suggested_title: z.string().max(200).nullable(),
    questions: z.array(shortText).max(5),
    confidence: z.number().min(0).max(1),
    limitations: z.array(shortText).max(30),
  }),
});

export type ValidatedInvestigationReport = z.infer<typeof investigationReportSchema>;
