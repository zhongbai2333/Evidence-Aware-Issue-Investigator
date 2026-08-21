import { z } from "zod";

const authSchema = z
  .object({
    mode: z.enum(["none", "environment", "command"]).default("none"),
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
  })
  .default({ mode: "none", args: [] });

export const providerSchema = z
  .object({
    kind: z.enum(["native", "compatible", "enterprise", "local"]).default("compatible"),
    model: z.string().min(1),
    baseUrl: z.string().url().optional(),
    protocol: z
      .enum(["responses", "chat-completions", "anthropic-messages"])
      .default("responses"),
    auth: authSchema,
    headersFromEnv: z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
  })
  .superRefine((provider, context) => {
    if (provider.kind !== "native" && !provider.baseUrl) {
      context.addIssue({ code: "custom", path: ["baseUrl"], message: "A non-native provider requires baseUrl" });
    }
    if (provider.auth.mode === "environment" && !provider.auth.env) {
      context.addIssue({ code: "custom", path: ["auth", "env"], message: "Environment auth requires env" });
    }
    if (provider.auth.mode === "command" && !provider.auth.command) {
      context.addIssue({ code: "custom", path: ["auth", "command"], message: "Command auth requires command" });
    }
  });

const investigationSchema = z
  .object({
    engine: z.enum(["none", "codex", "claude", "dsh", "custom"]).default("none"),
    provider: z.string().optional(),
    fallbackProviders: z.array(z.string()).max(5).default([]),
    trigger: z.enum(["never", "label", "bugs", "always"]).default("label"),
    triggerLabel: z.string().default("AI-Investigate"),
    bugLabels: z.array(z.string()).default(["bug", "BUG"]),
    mode: z.enum(["plan", "execute"]).default("plan"),
    command: z.string().min(1).optional(),
    argsPrefix: z.array(z.string()).default([]),
    timeoutMinutes: z.number().int().min(1).max(60).default(15),
    maxTurns: z.number().int().min(1).max(100).default(20),
    workspace: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
    network: z.boolean().default(false),
    allowUnsafeCredentialInheritance: z.boolean().default(false),
  })
  .default({
    engine: "none",
    fallbackProviders: [],
    trigger: "label",
    triggerLabel: "AI-Investigate",
    bugLabels: ["bug", "BUG"],
    mode: "plan",
    argsPrefix: [],
    timeoutMinutes: 15,
    maxTurns: 20,
    workspace: "workspace-write",
    network: false,
    allowUnsafeCredentialInheritance: false,
  });

export const configSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    cli: z
      .object({
        install: z.enum(["preinstalled", "npx"]).default("preinstalled"),
        versions: z
          .object({
            codex: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).optional(),
            claude: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).optional(),
            dsh: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).optional(),
          })
          .default({}),
      })
      .default({ install: "preinstalled", versions: {} }),
    providers: z.record(z.string(), providerSchema).default({}),
    triage: z
      .object({
        duplicateSearch: z.boolean().default(true),
        maxDuplicateCandidates: z.number().int().min(1).max(20).default(8),
      })
      .default({ duplicateSearch: true, maxDuplicateCandidates: 8 }),
    investigation: investigationSchema,
    evidencePolicy: z
      .object({
        unreproducedMaxPriority: z.enum(["medium", "low"]).default("medium"),
        requireObservedCommandForReproduced: z.boolean().default(true),
        requireReplayForVerifiedSteps: z.boolean().default(true),
        allowUnreproducedHighImpactPriority: z.boolean().default(false),
      })
      .default({
        unreproducedMaxPriority: "medium",
        requireObservedCommandForReproduced: true,
        requireReplayForVerifiedSteps: true,
        allowUnreproducedHighImpactPriority: false,
      }),
    replay: z
      .object({
        enabled: z.boolean().default(false),
        executor: z.enum(["container", "host"]).default("container"),
        containerImage: z
          .string()
          .regex(/^.+@sha256:[0-9a-f]{64}$/)
          .optional(),
        allowUnsafeHostExecution: z.boolean().default(false),
        probes: z
          .record(
            z.string(),
            z.object({
              command: z.array(z.string()).min(1),
              timeoutMinutes: z.number().int().min(1).max(30).default(10),
              expectedExitCodes: z.array(z.number().int()).min(1).default([0]),
              outcome: z.enum(["reproduced", "not-reproduced"]).default("reproduced"),
              verifiedSteps: z.array(z.string()).min(1),
              network: z.boolean().default(false),
            }),
          )
          .default({}),
      })
      .default({
        enabled: false,
        executor: "container",
        allowUnsafeHostExecution: false,
        probes: {},
      })
      .superRefine((replay, context) => {
        if (replay.enabled && replay.executor === "container" && !replay.containerImage) {
          context.addIssue({ code: "custom", path: ["containerImage"], message: "Container replay requires a digest-pinned image" });
        }
        if (replay.enabled && replay.executor === "host" && !replay.allowUnsafeHostExecution) {
          context.addIssue({ code: "custom", path: ["allowUnsafeHostExecution"], message: "Host replay requires explicit unsafe opt-in" });
        }
      }),
    labels: z
      .object({
        types: z.record(z.string(), z.string()).default({
          bug: "BUG",
          enhancement: "Enhancement",
          documentation: "Documentation",
          question: "Question",
          unknown: "Question",
        }),
        priorities: z.record(z.string(), z.string()).default({
          critical: "priority: critical",
          high: "priority: high",
          medium: "priority: medium",
          low: "priority: low",
        }),
        dispositions: z.record(z.string(), z.string()).default({
          duplicate: "Duplicate",
          wontfix: "WontFix",
          invalid: "Invalid",
        }),
        needsInfo: z.string().default("Needs-Info"),
      })
      .default({
        types: { bug: "BUG", enhancement: "Enhancement", documentation: "Documentation", question: "Question", unknown: "Question" },
        priorities: { critical: "priority: critical", high: "priority: high", medium: "priority: medium", low: "priority: low" },
        dispositions: { duplicate: "Duplicate", wontfix: "WontFix", invalid: "Invalid" },
        needsInfo: "Needs-Info",
      }),
    mutation: z
      .object({
        mode: z.enum(["suggest", "maintainer-confirm"]).default("suggest"),
        confirmLabel: z.string().default("Confirm"),
        rerunLabel: z.string().default("AI-Rerun"),
        assignConfirmer: z.boolean().default(true),
        applySuggestedTitle: z.boolean().default(false),
        closeNegativeDispositions: z.boolean().default(true),
        rerunOnAuthorFollowup: z.boolean().default(true),
      })
      .default({
        mode: "suggest",
        confirmLabel: "Confirm",
        rerunLabel: "AI-Rerun",
        assignConfirmer: true,
        applySuggestedTitle: false,
        closeNegativeDispositions: true,
        rerunOnAuthorFollowup: true,
      }),
  })
  .default({
    schemaVersion: 1,
    cli: { install: "preinstalled", versions: {} },
    providers: {},
    triage: { duplicateSearch: true, maxDuplicateCandidates: 8 },
    investigation: {
      engine: "none",
      fallbackProviders: [],
      trigger: "label",
      triggerLabel: "AI-Investigate",
      bugLabels: ["bug", "BUG"],
      mode: "plan",
      argsPrefix: [],
      timeoutMinutes: 15,
      maxTurns: 20,
      workspace: "workspace-write",
      network: false,
      allowUnsafeCredentialInheritance: false,
    },
    labels: {
      types: { bug: "BUG", enhancement: "Enhancement", documentation: "Documentation", question: "Question", unknown: "Question" },
      priorities: { critical: "priority: critical", high: "priority: high", medium: "priority: medium", low: "priority: low" },
      dispositions: { duplicate: "Duplicate", wontfix: "WontFix", invalid: "Invalid" },
      needsInfo: "Needs-Info",
    },
    mutation: {
      mode: "suggest",
      confirmLabel: "Confirm",
      rerunLabel: "AI-Rerun",
      assignConfirmer: true,
      applySuggestedTitle: false,
      closeNegativeDispositions: true,
      rerunOnAuthorFollowup: true,
    },
    evidencePolicy: {
      unreproducedMaxPriority: "medium",
      requireObservedCommandForReproduced: true,
      requireReplayForVerifiedSteps: true,
      allowUnreproducedHighImpactPriority: false,
    },
    replay: {
      enabled: false,
      executor: "container",
      allowUnsafeHostExecution: false,
      probes: {},
    },
  });

export type InvestigatorConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;

export const REPORT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "issue", "agent", "investigation", "reproduction", "evidence", "assessment"],
  properties: {
    schema_version: { const: 1 },
    issue: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "number", "title", "url"],
      properties: {
        repository: { type: "string", maxLength: 300 },
        number: { type: "integer" },
        title: { type: "string", maxLength: 500 },
        url: { type: "string", maxLength: 2000 },
      },
    },
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["engine", "provider", "model"],
      properties: {
        engine: { enum: ["none", "codex", "claude", "dsh", "custom"] },
        provider: { type: ["string", "null"], maxLength: 200 },
        model: { type: ["string", "null"], maxLength: 300 },
      },
    },
    investigation: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "code_path_identified", "test_attempted", "environment_match"],
      properties: {
        status: { enum: ["planned", "completed", "failed", "skipped"] },
        summary: { type: "string", maxLength: 4000 },
        code_path_identified: { type: "boolean" },
        test_attempted: { type: "boolean" },
        environment_match: { enum: ["exact", "partial", "mismatch", "unknown"] },
      },
    },
    reproduction: {
      type: "object",
      additionalProperties: false,
      required: ["status", "requested_probe", "user_steps", "proposed_steps", "verified_steps"],
      properties: {
        status: { enum: ["reproduced", "not-reproduced", "inconclusive", "not-attempted"] },
        requested_probe: { type: ["string", "null"], maxLength: 100 },
        user_steps: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
        proposed_steps: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
        verified_steps: { type: "array", maxItems: 20, items: { type: "string", maxLength: 1000 } },
      },
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["commands", "code_locations", "observations"],
      properties: {
        commands: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["command", "exit_code", "observation"],
            properties: {
              command: { type: "string", maxLength: 2000 },
              exit_code: { type: ["integer", "null"] },
              observation: { type: "string", maxLength: 4000 },
            },
          },
        },
        code_locations: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "line", "relevance"],
            properties: {
              path: { type: "string", maxLength: 1000 },
              line: { type: ["integer", "null"] },
              relevance: { type: "string", maxLength: 1000 },
            },
          },
        },
        observations: { type: "array", maxItems: 100, items: { type: "string", maxLength: 1000 } },
      },
    },
    assessment: {
      type: "object",
      additionalProperties: false,
      required: ["type", "disposition", "duplicate_of", "priority", "risk_flags", "needs_info", "suggested_title", "questions", "confidence", "limitations"],
      properties: {
        type: { enum: ["bug", "enhancement", "documentation", "question", "unknown"] },
        disposition: { enum: ["none", "duplicate", "wontfix", "invalid"] },
        duplicate_of: { type: ["integer", "null"] },
        priority: { enum: ["critical", "high", "medium", "low", "none"] },
        risk_flags: {
          type: "array",
          uniqueItems: true,
          items: { enum: ["security", "data-loss", "complete-outage"] },
        },
        needs_info: { type: "boolean" },
        suggested_title: { type: ["string", "null"], maxLength: 200 },
        questions: { type: "array", maxItems: 5, items: { type: "string", maxLength: 1000 } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        limitations: { type: "array", maxItems: 30, items: { type: "string", maxLength: 1000 } },
      },
    },
  },
} as const;
