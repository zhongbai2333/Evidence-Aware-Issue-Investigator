export type AgentEngine = "none" | "codex" | "claude" | "dsh" | "custom";

export type ProviderProtocol =
  | "responses"
  | "chat-completions"
  | "anthropic-messages";

export interface IssueSnapshot {
  repository: string;
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  url: string;
}

export interface DuplicateCandidate {
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
  bodySnippet: string;
}

export interface AgentInvocationPlan {
  engine: AgentEngine;
  provider: string | null;
  model: string | null;
  command: string;
  args: string[];
  cwd: string;
  environment: Record<
    string,
    {
      fromEnv?: string;
      value?: string;
      sensitive: boolean;
    }
  >;
  generatedFiles: Record<string, string>;
  outputFormat: "json" | "jsonl" | "text";
  timeoutMs: number;
  versionCheck: {
    command: string;
    args: string[];
    expectedVersion: string | null;
  } | null;
  credentialProxy: {
    upstreamBaseUrl: string;
    sourceEnv: string;
    protocol: ProviderProtocol;
    maxRequests: number;
    headersFromEnv: Record<string, string>;
  } | null;
}

export interface InvestigationReport {
  schema_version: 1;
  issue: {
    repository: string;
    number: number;
    title: string;
    url: string;
  };
  agent: {
    engine: AgentEngine;
    provider: string | null;
    model: string | null;
  };
  investigation: {
    status: "planned" | "completed" | "failed" | "skipped";
    summary: string;
    code_path_identified: boolean;
    test_attempted: boolean;
    environment_match: "exact" | "partial" | "mismatch" | "unknown";
  };
  reproduction: {
    status: "reproduced" | "not-reproduced" | "inconclusive" | "not-attempted";
    requested_probe: string | null;
    user_steps: string[];
    proposed_steps: string[];
    verified_steps: string[];
  };
  evidence: {
    commands: Array<{
      command: string;
      exit_code: number | null;
      observation: string;
    }>;
    code_locations: Array<{
      path: string;
      line: number | null;
      relevance: string;
    }>;
    observations: string[];
  };
  assessment: {
    type: "bug" | "enhancement" | "documentation" | "question" | "unknown";
    disposition: "none" | "duplicate" | "wontfix" | "invalid";
    duplicate_of: number | null;
    priority: "critical" | "high" | "medium" | "low" | "none";
    risk_flags: Array<"security" | "data-loss" | "complete-outage">;
    needs_info: boolean;
    suggested_title: string | null;
    questions: string[];
    confidence: number;
    limitations: string[];
  };
}
