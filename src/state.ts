import type { getOctokit } from "@actions/github";
import type { InvestigationReport } from "./contracts";
import type { IssueEventContext } from "./event";
import { isInvestigatorComment, parseReportMarker } from "./render";
import type { InvestigatorConfig } from "./schema";

type Octokit = ReturnType<typeof getOctokit>;
export type StateOperation = "confirm" | "followup-rerun" | "noop";

const maintainerPermissions = new Set(["admin", "maintain", "write", "triage"]);

function repositoryParts(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository: ${repository}`);
  return { owner, repo };
}

async function removeLabelIfPresent(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await octokit.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name: label });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status !== 404) throw error;
  }
}

async function ensureLabels(octokit: Octokit, owner: string, repo: string, labels: string[]): Promise<void> {
  const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
  const existingNames = new Set(existing.map((label) => label.name.toLowerCase()));
  const colors = ["5319e7", "1d76db", "0e8a16", "fbca04", "d93f0b", "b60205"];
  for (const [index, name] of labels.entries()) {
    if (!name || existingNames.has(name.toLowerCase())) continue;
    try {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name,
        color: colors[index % colors.length]!,
        description: "Managed by Evidence-Aware Issue Investigator",
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 422) throw error;
    }
    existingNames.add(name.toLowerCase());
  }
}

function desiredLabels(report: InvestigationReport, config: InvestigatorConfig): Set<string> {
  const desired = new Set<string>();
  if (report.assessment.disposition !== "none") {
    const disposition = config.labels.dispositions[report.assessment.disposition];
    if (disposition) desired.add(disposition);
  } else {
    const type = config.labels.types[report.assessment.type];
    if (type) desired.add(type);
    if (report.assessment.priority !== "none") {
      const priority = config.labels.priorities[report.assessment.priority];
      if (priority) desired.add(priority);
    }
  }
  if (report.assessment.needs_info) desired.add(config.labels.needsInfo);
  return desired;
}

async function latestBotReport(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<InvestigationReport | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  for (const comment of [...comments].reverse()) {
    if (
      comment.user?.type === "Bot" &&
      comment.user?.login === "github-actions[bot]" &&
      isInvestigatorComment(comment.body)
    ) {
      const report = parseReportMarker(comment.body);
      if (report) return report;
    }
  }
  return null;
}

async function handleConfirm(
  octokit: Octokit,
  event: IssueEventContext,
  config: InvestigatorConfig,
): Promise<StateOperation> {
  if (
    config.mutation.mode !== "maintainer-confirm" ||
    event.eventName !== "issues" ||
    event.action !== "labeled" ||
    event.label?.toLowerCase() !== config.mutation.confirmLabel.toLowerCase()
  ) {
    return "noop";
  }
  const { owner, repo } = repositoryParts(event.issue.repository);
  const issueNumber = event.issue.number;
  let permission = "none";
  if (event.sender) {
    try {
      const permissionResponse = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: event.sender,
      });
      permission = String(permissionResponse.data.permission ?? "none").toLowerCase();
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
  if (!maintainerPermissions.has(permission)) {
    await removeLabelIfPresent(octokit, owner, repo, issueNumber, config.mutation.confirmLabel);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `@${event.sender} does not have permission to apply the investigation report. The confirmation label was removed.`,
    });
    return "confirm";
  }

  const report = await latestBotReport(octokit, owner, repo, issueNumber);
  if (!report || report.issue.repository !== event.issue.repository || report.issue.number !== issueNumber) {
    await removeLabelIfPresent(octokit, owner, repo, issueNumber, config.mutation.confirmLabel);
    throw new Error("No valid controller-bound investigation report was found for confirmation");
  }

  const desired = desiredLabels(report, config);
  await ensureLabels(octokit, owner, repo, [...desired]);
  const managedGroups = [
    ...Object.values(config.labels.types),
    ...Object.values(config.labels.priorities),
    ...Object.values(config.labels.dispositions),
    config.labels.needsInfo,
  ];
  const desiredLower = new Set([...desired].map((label) => label.toLowerCase()));
  for (const existing of event.issue.labels) {
    if (
      managedGroups.some((managed) => managed.toLowerCase() === existing.toLowerCase()) &&
      !desiredLower.has(existing.toLowerCase())
    ) {
      await removeLabelIfPresent(octokit, owner, repo, issueNumber, existing);
    }
  }
  if (desired.size) {
    await octokit.rest.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [...desired] });
  }
  for (const transient of [config.mutation.confirmLabel, config.mutation.rerunLabel, config.investigation.triggerLabel]) {
    await removeLabelIfPresent(octokit, owner, repo, issueNumber, transient);
  }

  if (
    config.mutation.assignConfirmer &&
    report.assessment.disposition === "none" &&
    !report.assessment.needs_info
  ) {
    await octokit.rest.issues.addAssignees({ owner, repo, issue_number: issueNumber, assignees: [event.sender] });
  }
  if (config.mutation.applySuggestedTitle && report.assessment.suggested_title) {
    await octokit.rest.issues.update({
      owner,
      repo,
      issue_number: issueNumber,
      title: report.assessment.suggested_title,
    });
  }
  if (
    config.mutation.closeNegativeDispositions &&
    ["duplicate", "wontfix", "invalid"].includes(report.assessment.disposition)
  ) {
    await octokit.rest.issues.update({ owner, repo, issue_number: issueNumber, state: "closed", state_reason: "not_planned" });
  }
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: [
      "### Investigation report applied",
      `Confirmed by @${event.sender}.`,
      `Disposition: \`${report.assessment.disposition}\`.`,
      `Labels: ${[...desired].map((label) => `\`${label}\``).join(" ") || "none"}.`,
      report.assessment.duplicate_of ? `Duplicate target: #${report.assessment.duplicate_of}.` : "",
    ].filter(Boolean).join("\n"),
  });
  return "confirm";
}

async function handleAuthorFollowup(
  octokit: Octokit,
  event: IssueEventContext,
  config: InvestigatorConfig,
): Promise<StateOperation> {
  if (
    !config.mutation.rerunOnAuthorFollowup ||
    event.eventName !== "issue_comment" ||
    event.action !== "created" ||
    !event.commentAuthor ||
    event.commentAuthor.toLowerCase() !== event.issue.author.toLowerCase() ||
    !event.issue.labels.some((label) => label.toLowerCase() === config.labels.needsInfo.toLowerCase())
  ) {
    return "noop";
  }
  const { owner, repo } = repositoryParts(event.issue.repository);
  await removeLabelIfPresent(octokit, owner, repo, event.issue.number, config.labels.needsInfo);
  await ensureLabels(octokit, owner, repo, [config.mutation.rerunLabel]);
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: event.issue.number,
    labels: [config.mutation.rerunLabel],
  });
  return "followup-rerun";
}

export async function handleStateEvent(
  octokit: Octokit,
  event: IssueEventContext,
  config: InvestigatorConfig,
): Promise<StateOperation> {
  const confirm = await handleConfirm(octokit, event, config);
  if (confirm !== "noop") return confirm;
  return await handleAuthorFollowup(octokit, event, config);
}
