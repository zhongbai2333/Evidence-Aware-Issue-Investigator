import * as core from "@actions/core";
import * as github from "@actions/github";
import { applyRuntimeOverrides, loadConfig } from "./config";
import { isPullRequestIssueEvent, loadIssueEvent } from "./event";
import type { DuplicateCandidate, InvestigationReport, IssueSnapshot } from "./contracts";
import { buildInvestigationPrompt } from "./prompt";
import { shouldInvestigate } from "./policy";
import { planAgentInvocation } from "./adapters";
import { resolveProvider } from "./adapters/base";
import { assertExecutionSafety, runAgent } from "./runner";
import { investigationReportSchema } from "./report";
import { isInvestigatorComment, renderReportComment } from "./render";
import { searchDuplicateCandidates } from "./duplicates";
import { normalizeEvidence } from "./evidence";
import { runReplay } from "./replay";
import { handleStateEvent, type StateOperation } from "./state";
import { reviewAndDownloadAttachments, type ControllerNetworkReview } from "./network-review";
import { controllerSecrets, reviewBoundary, screenText, screenValue } from "./boundary";

function publicControllerReview(review: ControllerNetworkReview) {
  return {
    status: review.status,
    summary: review.summary,
    attachments: review.attachments.map(({ path, filename, bytes, sha256 }) => ({ path, filename, bytes, sha256 })),
    reviewedEgressAvailable: false,
  };
}

function plannedReport(
  issue: IssueSnapshot,
  engine: InvestigationReport["agent"]["engine"],
  provider: string | null,
  model: string | null,
  summary: string,
  status: "planned" | "skipped" = "planned",
): InvestigationReport {
  return {
    schema_version: 1,
    issue: {
      repository: issue.repository,
      number: issue.number,
      title: issue.title,
      url: issue.url,
    },
    agent: { engine, provider, model },
    investigation: {
      status,
      summary,
      code_path_identified: false,
      test_attempted: false,
      environment_match: "unknown",
    },
    reproduction: {
      status: "not-attempted",
      requested_probe: null,
      user_steps: [],
      proposed_steps: [],
      verified_steps: [],
    },
    evidence: { commands: [], code_locations: [], observations: [] },
    assessment: {
      type: "unknown",
      disposition: "none",
      duplicate_of: null,
      priority: "none",
      risk_flags: [],
      needs_info: false,
      suggested_title: null,
      questions: [],
      confidence: 0,
      limitations: status === "planned" ? ["The agent invocation was planned but not executed."] : [],
    },
  };
}

async function publishComment(token: string, report: InvestigationReport): Promise<void> {
  if (!token) throw new Error("github-token is required when publish-comment=true");
  const octokit = github.getOctokit(token);
  const [owner, repo] = report.issue.repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository: ${report.issue.repository}`);
  const body = renderReportComment(report);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: report.issue.number,
    per_page: 100,
  });
  const existing = [...comments].reverse().find(
    (comment) =>
      isInvestigatorComment(comment.body) &&
      comment.user?.type === "Bot" &&
      comment.user?.login === "github-actions[bot]",
  );
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: report.issue.number, body });
  }
}

async function main(): Promise<void> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set");
  if (await isPullRequestIssueEvent(eventPath)) {
    core.info("Skipping pull request issue_comment event.");
    core.setOutput("report-json", "");
    core.setOutput("investigation-status", "skipped");
    core.setOutput("agent-engine", "none");
    core.setOutput("provider", "native");
    core.setOutput("operation", "noop");
    return;
  }

  const loadedConfig = await loadConfig(workspace, core.getInput("config-path") || ".github/issue-investigator.yml");
  const config = applyRuntimeOverrides(loadedConfig, {
    engine: core.getInput("agent-engine") || undefined,
    provider: core.getInput("provider") || undefined,
    model: core.getInput("model") || undefined,
    mode: core.getInput("execution-mode") || undefined,
    containerImage: core.getInput("container-image") || undefined,
  });
  const event = await loadIssueEvent(eventPath, process.env.GITHUB_EVENT_NAME ?? "");
  const issue = screenValue(event.issue, controllerSecrets(resolveProvider(config).provider));
  const { name: providerName, provider } = resolveProvider(config);
  const token = core.getInput("github-token");
  let operation: StateOperation | "investigate" = "noop";
  if (token) {
    operation = await handleStateEvent(github.getOctokit(token), event, config);
  } else if (
    (event.eventName === "issues" && event.action === "labeled" && event.label?.toLowerCase() === config.mutation.confirmLabel.toLowerCase()) ||
    event.eventName === "issue_comment"
  ) {
    throw new Error("github-token is required for confirmation and follow-up state transitions");
  }
  if (operation !== "noop") {
    core.setOutput("report-json", "");
    core.setOutput("investigation-status", "skipped");
    core.setOutput("agent-engine", config.investigation.engine);
    core.setOutput("provider", providerName ?? "native");
    core.setOutput("operation", operation);
    return;
  }
  if (event.eventName === "issue_comment") {
    core.setOutput("report-json", "");
    core.setOutput("investigation-status", "skipped");
    core.setOutput("agent-engine", config.investigation.engine);
    core.setOutput("provider", providerName ?? "native");
    core.setOutput("operation", "noop");
    return;
  }
  const isInvestigationEvent =
    event.eventName === "issues" &&
    (
      event.action === "opened" ||
      event.action === "reopened" ||
      (
        event.action === "labeled" &&
        !!event.label &&
        [config.investigation.triggerLabel, config.mutation.rerunLabel]
          .some((label) => label.toLowerCase() === event.label!.toLowerCase())
      )
    );
  if (event.eventName && !isInvestigationEvent) {
    core.setOutput("report-json", "");
    core.setOutput("investigation-status", "skipped");
    core.setOutput("agent-engine", config.investigation.engine);
    core.setOutput("provider", providerName ?? "native");
    core.setOutput("operation", "noop");
    return;
  }
  let duplicateCandidates: DuplicateCandidate[] = [];
  if (config.triage.duplicateSearch && token) {
    try {
      duplicateCandidates = await searchDuplicateCandidates(
        github.getOctokit(token),
        issue,
        config.triage.maxDuplicateCandidates,
      );
    } catch (error) {
      core.warning(`Duplicate candidate search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let report: InvestigationReport;
  if (!shouldInvestigate(issue, config)) {
    report = plannedReport(
      issue,
      config.investigation.engine,
      providerName,
      provider?.model ?? null,
      "Investigation policy did not select this Issue.",
      "skipped",
    );
  } else if (config.investigation.engine === "none") {
    report = plannedReport(issue, "none", providerName, provider?.model ?? null, "No agent engine is configured.", "skipped");
  } else {
    operation = "investigate";
    if (config.investigation.mode === "plan") {
      const prompt = buildInvestigationPrompt(issue, { duplicateCandidates, isolatedOnline: config.investigation.isolation.executor === "container" });
      const plan = planAgentInvocation({ config, providerName, provider, prompt, workspace });
      assertExecutionSafety(config, provider);
      report = plannedReport(
        issue,
        plan.engine,
        plan.provider,
        plan.model,
        `Prepared a bounded ${plan.engine} investigation plan using provider ${plan.provider ?? "native"}.`,
      );
      core.info(`Planned command: ${plan.command} (${plan.args.length} arguments; prompt redacted)`);
    } else {
      const attemptNames = [...new Set([providerName, ...config.investigation.fallbackProviders])];
      const failures: string[] = [];
      let completedReport: InvestigationReport | null = null;
      for (const attemptName of attemptNames) {
        try {
          const attemptConfig = structuredClone(config);
          if (attemptName) attemptConfig.investigation.provider = attemptName;
          else delete attemptConfig.investigation.provider;
          const resolved = resolveProvider(attemptConfig);
          const isolatedOnline = attemptConfig.investigation.isolation.executor === "container";
          if (isolatedOnline) {
            assertExecutionSafety(attemptConfig, resolved.provider);
            duplicateCandidates = screenValue(duplicateCandidates, controllerSecrets(resolved.provider));
            await reviewBoundary("input", { issue, duplicateCandidates }, resolved.provider!);
            core.info("Boundary input review approved. Investigation will use an isolated online container.");
          }
          const controllerReview = attemptConfig.investigation.approvalMode === "auto-review"
            ? await reviewAndDownloadAttachments(issue, resolved.provider)
            : {
                status: "not-needed" as const,
                summary: "Controller Auto-review is disabled.",
                attachments: [],
                decisions: [],
              };
          core.info(`Controller Auto-review status: ${controllerReview.status}; approved ${controllerReview.attachments.length} attachment(s).`);
          for (const decision of controllerReview.decisions) {
            core.info(`Controller Auto-review ${decision.approved ? "approved" : "denied"} ${decision.id}: ${decision.reason.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 500)}`);
          }
          if (controllerReview.status === "failed") {
            core.warning(`Controller Auto-review failed closed: ${controllerReview.summary}`);
          }
          const prompt = buildInvestigationPrompt(issue, {
            duplicateCandidates,
            isolatedOnline,
            controllerReview: {
              ...publicControllerReview(controllerReview),
              reviewedEgressAvailable: attemptConfig.investigation.approvalMode === "auto-review" && !!resolved.provider,
            },
          });
          const plan = planAgentInvocation({
            config: attemptConfig,
            providerName: resolved.name,
            provider: resolved.provider,
            prompt,
            workspace,
          });
          plan.workspaceFiles = Object.fromEntries(
            controllerReview.attachments.map((attachment) => [attachment.path, attachment.content]),
          );
          if (attemptConfig.investigation.approvalMode === "auto-review" && resolved.provider) {
            plan.reviewedEgress = {
              issue,
              provider: resolved.provider,
              maxRequests: attemptConfig.investigation.reviewedNetworkMaxRequests,
              maxResponseBytes: attemptConfig.investigation.reviewedNetworkMaxResponseBytes,
            };
          }
          assertExecutionSafety(attemptConfig, resolved.provider);
          const result = await runAgent(plan);
          const boundReport = investigationReportSchema.parse({
            ...result.report,
            issue: {
              repository: issue.repository,
              number: issue.number,
              title: issue.title,
              url: issue.url,
            },
            agent: {
              engine: plan.engine,
              provider: plan.provider,
              model: plan.model,
            },
          });
          if (controllerReview.status === "failed") {
            boundReport.assessment.limitations.push(
              `Controller Auto-review failed closed: ${controllerReview.summary}`,
            );
          }
          let replay;
          if (boundReport.reproduction.requested_probe && attemptConfig.replay.enabled) {
            try {
              replay = await runReplay(workspace, boundReport.reproduction.requested_probe, attemptConfig);
            } catch (error) {
              core.warning(`Clean replay failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          completedReport = normalizeEvidence(boundReport, {
            config: attemptConfig,
            duplicateCandidates,
            observedCommands: result.observedCommands,
            workspaceChanges: result.workspaceChanges,
            replay,
          });
          completedReport = screenValue(completedReport, controllerSecrets(resolved.provider));
          if (isolatedOnline) {
            completedReport.assessment.limitations = completedReport.assessment.limitations.slice(0, 29);
            completedReport.assessment.limitations.push("Container executor telemetry is untrusted evidence; no independent clean replay was performed unless separately reported.");
            // The reviewer runs outside the executor and can neither execute its output nor grant tools.
            await reviewBoundary("output", completedReport, resolved.provider!);
            investigationReportSchema.parse(completedReport);
            core.info("Boundary output review approved. Container and model proxy have been destroyed before publication.");
          }
          if (controllerReview.status === "completed") {
            completedReport.evidence.observations.push(
              `Controller Auto-review approved and supplied ${controllerReview.attachments.length} public Issue attachment(s).`,
            );
          }
          const approvedNetwork = result.reviewedEgressAudits.filter((item) => item.approved && item.statusCode !== null);
          const deniedNetwork = result.reviewedEgressAudits.filter((item) => !item.approved);
          const failedNetwork = result.reviewedEgressAudits.filter((item) => item.approved && item.statusCode === null);
          if (approvedNetwork.length || deniedNetwork.length || failedNetwork.length) {
            completedReport.evidence.observations.push(
              `Controller reviewed dynamic network requests: ${approvedNetwork.length} completed, ${deniedNetwork.length} denied, ${failedNetwork.length} failed closed.`,
            );
          }
          break;
        } catch (error) {
          completedReport = null;
          const failure = screenText(error instanceof Error ? error.message : String(error), Object.values(config.providers).flatMap((entry) => controllerSecrets(entry))).replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted-url]");
          failures.push(`${attemptName ?? "native"}: ${failure.slice(0, 1000)}`);
          core.warning(`Investigation attempt failed for provider ${attemptName ?? "native"}: ${failure}`);
        }
      }
      if (!completedReport) throw new Error(`All provider attempts failed: ${failures.join(" | ")}`);
      report = completedReport;
    }
  }

  if (core.getBooleanInput("publish-comment")) {
    await publishComment(token, report);
  }

  core.setOutput("report-json", JSON.stringify(report));
  core.setOutput("investigation-status", report.investigation.status);
  core.setOutput("agent-engine", report.agent.engine);
  core.setOutput("provider", report.agent.provider ?? "native");
  core.setOutput("operation", operation);
}

main().catch((error: unknown) => {
  core.setFailed(screenText(error instanceof Error ? error.message : String(error)).replace(/(?:https?|wss?):\/\/\S+/gi, "[redacted-url]"));
});
