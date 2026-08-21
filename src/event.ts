import { readFile } from "node:fs/promises";
import type { IssueSnapshot } from "./contracts";

interface GitHubEvent {
  action?: string;
  sender?: { login?: string };
  label?: { name?: string };
  comment?: { body?: string | null; user?: { login?: string } };
  repository?: { full_name?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    html_url?: string;
    pull_request?: unknown;
    user?: { login?: string };
    labels?: Array<string | { name?: string }>;
  };
}

export interface IssueEventContext {
  issue: IssueSnapshot;
  eventName: string;
  action: string;
  sender: string;
  label: string | null;
  commentBody: string | null;
  commentAuthor: string | null;
}

export async function isPullRequestIssueEvent(eventPath: string): Promise<boolean> {
  const event = JSON.parse(await readFile(eventPath, "utf8")) as GitHubEvent;
  return Boolean(event.issue?.pull_request);
}

export async function loadIssueEvent(eventPath: string, eventName = ""): Promise<IssueEventContext> {
  const event = JSON.parse(await readFile(eventPath, "utf8")) as GitHubEvent;
  return {
    issue: snapshotFromEvent(event),
    eventName,
    action: String(event.action ?? ""),
    sender: String(event.sender?.login ?? ""),
    label: event.label?.name ? String(event.label.name) : null,
    commentBody: event.comment?.body == null ? null : String(event.comment.body).slice(0, 20_000),
    commentAuthor: event.comment?.user?.login ? String(event.comment.user.login) : null,
  };
}

export async function loadIssueSnapshot(eventPath: string): Promise<IssueSnapshot> {
  const event = JSON.parse(await readFile(eventPath, "utf8")) as GitHubEvent;
  return snapshotFromEvent(event);
}

function snapshotFromEvent(event: GitHubEvent): IssueSnapshot {
  const issue = event.issue;

  if (!issue || issue.pull_request) {
    throw new Error("This action requires a GitHub Issue event, not a pull request event.");
  }

  const repository = String(event.repository?.full_name ?? "").trim();
  const number = Number(issue.number);
  if (!repository || !Number.isInteger(number) || number <= 0) {
    throw new Error("The event does not contain a valid repository and issue number.");
  }

  return {
    repository,
    number,
    title: String(issue.title ?? "").slice(0, 500),
    body: String(issue.body ?? "").slice(0, 20_000),
    author: String(issue.user?.login ?? "unknown"),
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name ?? ""))
      .filter(Boolean),
    url: String(issue.html_url ?? `https://github.com/${repository}/issues/${number}`),
  };
}
