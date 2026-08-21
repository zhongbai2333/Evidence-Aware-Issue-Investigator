import type { getOctokit } from "@actions/github";
import type { DuplicateCandidate, IssueSnapshot } from "./contracts";

type Octokit = ReturnType<typeof getOctokit>;

function searchTokens(issue: IssueSnapshot): string[] {
  const normalized = `${issue.title} ${issue.body.slice(0, 800)}`
    .normalize("NFKC")
    .replace(/\b(?:repo|org|user|is|state|label|author|assignee|in):\S+/gi, " ");
  const raw = normalized.match(/[A-Za-z][A-Za-z0-9_-]{2,}|[\u3400-\u9fff]{2,8}|\d{3,}/g) ?? [];
  const stop = new Set(["issue", "bug", "问题", "功能", "无法", "失败", "使用", "版本", "报错"]);
  return [...new Set(raw.map((token) => token.toLowerCase()).filter((token) => !stop.has(token)))].slice(0, 6);
}

export async function searchDuplicateCandidates(
  octokit: Octokit,
  issue: IssueSnapshot,
  maxCandidates: number,
): Promise<DuplicateCandidate[]> {
  const tokens = searchTokens(issue);
  if (!tokens.length) return [];
  const [owner, repo] = issue.repository.split("/");
  if (!owner || !repo) return [];

  const query = `repo:${owner}/${repo} is:issue ${tokens.join(" ")}`;
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: Math.min(30, Math.max(maxCandidates * 2, 10)),
  });

  return response.data.items
    .filter((item) => item.number !== issue.number && !item.pull_request)
    .slice(0, maxCandidates)
    .map((item) => ({
      number: item.number,
      title: String(item.title ?? "").slice(0, 300),
      state: String(item.state ?? "unknown"),
      labels: (item.labels ?? [])
        .map((label) => typeof label === "string" ? label : label.name ?? "")
        .filter(Boolean),
      url: String(item.html_url ?? ""),
      bodySnippet: String(item.body ?? "").replace(/\s+/g, " ").slice(0, 500),
    }));
}
