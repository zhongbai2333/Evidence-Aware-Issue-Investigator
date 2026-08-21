import type { IssueSnapshot } from "../src/contracts";

export const issueFixture: IssueSnapshot = {
  repository: "example/project",
  number: 408,
  title: "Search fails by title",
  body: "Search for a title returns search_books.",
  author: "reporter",
  labels: ["BUG"],
  url: "https://github.com/example/project/issues/408",
};
