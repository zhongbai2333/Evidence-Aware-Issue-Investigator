import type { InvestigationReport } from "./contracts";
import { investigationReportSchema } from "./report";
import { gunzipSync, gzipSync } from "node:zlib";

const MARKER = "<!-- evidence-aware-issue-investigator -->";
const REPORT_PREFIX = "<!-- evidence-aware-issue-investigator-report:v1:";

export function encodeReportMarker(report: InvestigationReport): string {
  const compact: InvestigationReport = {
    ...report,
    investigation: { ...report.investigation, summary: report.investigation.summary.slice(0, 2000) },
    reproduction: {
      ...report.reproduction,
      user_steps: report.reproduction.user_steps.slice(0, 10).map((item) => item.slice(0, 500)),
      proposed_steps: report.reproduction.proposed_steps.slice(0, 10).map((item) => item.slice(0, 500)),
      verified_steps: report.reproduction.verified_steps.slice(0, 10).map((item) => item.slice(0, 500)),
    },
    evidence: {
      commands: report.evidence.commands.slice(0, 10).map((item) => ({
        ...item,
        command: item.command.slice(0, 500),
        observation: item.observation.slice(0, 500),
      })),
      code_locations: report.evidence.code_locations.slice(0, 20),
      observations: report.evidence.observations.slice(0, 20).map((item) => item.slice(0, 500)),
    },
    assessment: {
      ...report.assessment,
      limitations: report.assessment.limitations.slice(0, 20).map((item) => item.slice(0, 500)),
    },
  };
  const payload = gzipSync(Buffer.from(JSON.stringify(compact), "utf8")).toString("base64url");
  return `${REPORT_PREFIX}${payload} -->`;
}

export function parseReportMarker(body: string | null | undefined): InvestigationReport | null {
  const text = String(body ?? "");
  const start = text.lastIndexOf(REPORT_PREFIX);
  if (start < 0) return null;
  const payloadStart = start + REPORT_PREFIX.length;
  const end = text.indexOf(" -->", payloadStart);
  if (end < 0) return null;
  try {
    return investigationReportSchema.parse(
      JSON.parse(gunzipSync(
        Buffer.from(text.slice(payloadStart, end), "base64url"),
        { maxOutputLength: 200_000 },
      ).toString("utf8")),
    );
  } catch {
    return null;
  }
}

export function renderReportComment(report: InvestigationReport): string {
  const lines = [
    "## 🔎 Evidence-aware Issue investigation",
    "",
    `- **Status**: \`${report.investigation.status}\``,
    `- **Agent**: \`${report.agent.engine}\``,
    `- **Provider / model**: \`${report.agent.provider ?? "native"}\` / \`${report.agent.model ?? "default"}\``,
    `- **Reproduction**: \`${report.reproduction.status}\``,
    `- **Environment match**: \`${report.investigation.environment_match}\``,
    `- **Suggested type / priority**: \`${report.assessment.type}\` / \`${report.assessment.priority}\``,
    `- **Disposition**: \`${report.assessment.disposition}\`${report.assessment.duplicate_of ? ` → #${report.assessment.duplicate_of}` : ""}`,
    `- **Suggested title**: ${report.assessment.suggested_title ? `\`${report.assessment.suggested_title}\`` : "none"}`,
    "",
    report.investigation.summary,
  ];

  if (report.assessment.limitations.length) {
    lines.push("", "### Limitations");
    for (const item of report.assessment.limitations.slice(0, 20)) lines.push(`- ${item.slice(0, 1000)}`);
  }
  if (report.assessment.questions.length) {
    lines.push("", "### Requested information");
    for (const item of report.assessment.questions) lines.push(`- ${item.slice(0, 1000)}`);
  }
  if (report.reproduction.proposed_steps.length) {
    lines.push("", "### Proposed reproduction steps (not necessarily verified)");
    for (const item of report.reproduction.proposed_steps.slice(0, 10)) lines.push(`- ${item.slice(0, 1000)}`);
  }
  if (report.reproduction.verified_steps.length) {
    lines.push("", "### Verified reproduction steps");
    for (const item of report.reproduction.verified_steps.slice(0, 10)) lines.push(`- ${item.slice(0, 1000)}`);
  }

  const marker = encodeReportMarker(report);
  lines.push("", MARKER, marker);
  const rendered = lines.join("\n");
  if (Buffer.byteLength(rendered, "utf8") <= 65_000) return rendered;
  const compact = [
    "## 🔎 Evidence-aware Issue investigation",
    "",
    `- **Status**: \`${report.investigation.status}\``,
    `- **Reproduction**: \`${report.reproduction.status}\``,
    `- **Suggested type / priority**: \`${report.assessment.type}\` / \`${report.assessment.priority}\``,
    "",
    report.investigation.summary.slice(0, 2000),
    "",
    "Detailed output was omitted because it exceeded the GitHub comment size budget.",
    "",
    MARKER,
    marker,
  ].join("\n");
  if (Buffer.byteLength(compact, "utf8") > 65_000) {
    throw new Error("Validated investigation report is too large for a safe GitHub comment marker");
  }
  return compact;
}

export function isInvestigatorComment(body: string | null | undefined): boolean {
  return String(body ?? "").includes(MARKER);
}
