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
  });
  const event = await loadIssueEvent(eventPath, process.env.GITHUB_EVENT_NAME ?? "");
  const issue = event.issue;
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
    const prompt = buildInvestigationPrompt(issue, { duplicateCandidates });
    if (config.investigation.mode === "plan") {
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
          const plan = planAgentInvocation({
            config: attemptConfig,
            providerName: resolved.name,
            provider: resolved.provider,
            prompt,
            workspace,
          });
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
          break;
        } catch (error) {
          const failure = error instanceof Error ? error.message : String(error);
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
  core.setFailed(error instanceof Error ? error.message : String(error));
});
