import type { DuplicateCandidate, InvestigationReport } from "./contracts";
import type { ObservedCommand, WorkspaceChange } from "./runner";
import type { InvestigatorConfig } from "./schema";
import type { ReplayResult } from "./replay";

const priorityRank = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
} as const;

function capPriority(
  priority: InvestigationReport["assessment"]["priority"],
  cap: "medium" | "low",
): InvestigationReport["assessment"]["priority"] {
  return priorityRank[priority] > priorityRank[cap] ? cap : priority;
}

export interface EvidenceContext {
  config: InvestigatorConfig;
  duplicateCandidates: DuplicateCandidate[];
  observedCommands: ObservedCommand[];
  workspaceChanges: WorkspaceChange[];
  replay?: ReplayResult;
}

export function normalizeEvidence(
  raw: InvestigationReport,
  context: EvidenceContext,
): InvestigationReport {
  const report = structuredClone(raw);
  const candidateNumbers = new Set(context.duplicateCandidates.map((candidate) => candidate.number));
  const replayVerifiedSteps = context.replay?.verifiedSteps ?? [];

  const controllerCommands = context.replay ? [...context.observedCommands, context.replay.command] : context.observedCommands;
  report.evidence.commands = controllerCommands.filter((command) => command.command).map((command) => ({
    command: command.command,
    exit_code: command.exitCode,
    observation: command.observation,
  }));
  report.evidence.observations = [
    ...report.evidence.observations.map((item) => `Agent observation: ${item}`),
    ...context.workspaceChanges.map((change) => `Controller observed workspace ${change.kind}: ${change.path}`),
  ];

  if (context.config.evidencePolicy.requireReplayForVerifiedSteps) {
    report.reproduction.verified_steps = replayVerifiedSteps;
  }
  if (context.replay?.verified) {
    report.reproduction.status = context.replay.outcome;
  } else if (report.reproduction.requested_probe && context.config.replay.enabled) {
    report.assessment.limitations.push(`Requested probe '${report.reproduction.requested_probe}' did not produce verified replay evidence.`);
  }

  if (
    report.reproduction.status === "reproduced" &&
    context.config.evidencePolicy.requireObservedCommandForReproduced &&
    context.observedCommands.length === 0 &&
    replayVerifiedSteps.length === 0
  ) {
    report.reproduction.status = "inconclusive";
    report.assessment.limitations.push("The agent claimed reproduction without a controller-observed command or clean replay.");
  }

  if (report.assessment.disposition === "duplicate") {
    if (!report.assessment.duplicate_of || !candidateNumbers.has(report.assessment.duplicate_of)) {
      report.assessment.disposition = "none";
      report.assessment.duplicate_of = null;
      report.assessment.limitations.push("The proposed duplicate target was not in the controller-provided candidate set.");
    } else {
      report.assessment.priority = "none";
    }
  } else {
    report.assessment.duplicate_of = null;
  }

  const highImpact = report.assessment.risk_flags.some((flag) =>
    flag === "security" || flag === "data-loss" || flag === "complete-outage"
  );
  if (
    report.reproduction.status !== "reproduced" &&
    (!highImpact || !context.config.evidencePolicy.allowUnreproducedHighImpactPriority)
  ) {
    const original = report.assessment.priority;
    report.assessment.priority = capPriority(original, context.config.evidencePolicy.unreproducedMaxPriority);
    if (original !== report.assessment.priority) {
      report.assessment.limitations.push("Priority was capped because the report was not reproduced and had no high-impact risk flag.");
    }
  }
  if (report.assessment.priority === "critical" && report.reproduction.status !== "reproduced") {
    report.assessment.priority = "high";
    report.assessment.limitations.push("Critical priority requires reproduced evidence; high-impact but unreproduced reports are capped at high.");
  }
  if (report.reproduction.status === "inconclusive" || report.investigation.environment_match === "mismatch") {
    report.assessment.needs_info = true;
  }
  if (report.assessment.suggested_title) {
    report.assessment.suggested_title = report.assessment.suggested_title
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || null;
  }
  report.assessment.questions = report.assessment.needs_info
    ? report.assessment.questions.slice(0, 5)
    : [];
  if (report.assessment.needs_info && report.assessment.questions.length === 0) {
    report.assessment.questions = ["Please provide the missing environment detail or complete error output needed to distinguish the remaining hypotheses."];
  }
  if (context.observedCommands.length === 0 && replayVerifiedSteps.length === 0) {
    report.assessment.confidence = Math.min(report.assessment.confidence, 0.7);
  }
  report.assessment.limitations = [...new Set(report.assessment.limitations)];
  return report;
}
