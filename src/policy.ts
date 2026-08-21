import type { IssueSnapshot } from "./contracts";
import type { InvestigatorConfig } from "./schema";

export function shouldInvestigate(issue: IssueSnapshot, config: InvestigatorConfig): boolean {
  const policy = config.investigation;
  const labels = new Set(issue.labels.map((label) => label.toLowerCase()));

  switch (policy.trigger) {
    case "never":
      return false;
    case "always":
      return true;
    case "label":
      return labels.has(policy.triggerLabel.toLowerCase()) || labels.has(config.mutation.rerunLabel.toLowerCase());
    case "bugs":
      return policy.bugLabels.some((label) => labels.has(label.toLowerCase()));
  }
}
