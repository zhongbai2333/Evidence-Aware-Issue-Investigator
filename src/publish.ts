import type { getOctokit } from "@actions/github";
import type { InvestigationReport } from "./contracts";
import { isInvestigatorComment, parseReportMarker, renderReportComment } from "./render";

type Octokit = ReturnType<typeof getOctokit>;

// Publish first: a failed replacement must never remove the last available report.
export async function publishReportComment(
  octokit: Octokit,
  report: InvestigationReport,
  warn: (message: string) => void,
): Promise<void> {
  const [owner, repo] = report.issue.repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository: ${report.issue.repository}`);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: report.issue.number, per_page: 100,
  });
  const previous = comments.filter((comment) => {
    if (comment.user?.type !== "Bot" || comment.user.login !== "github-actions[bot]" || !isInvestigatorComment(comment.body)) return false;
    const parsed = parseReportMarker(comment.body);
    return parsed?.issue.repository === report.issue.repository && parsed.issue.number === report.issue.number;
  });
  await octokit.rest.issues.createComment({
    owner, repo, issue_number: report.issue.number, body: renderReportComment(report),
  });
  for (const comment of previous) {
    try {
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: comment.id });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        warn(`New investigation report published, but previous bot report ${comment.id} could not be removed.`);
      }
    }
  }
}
