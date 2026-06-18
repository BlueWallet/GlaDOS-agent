import type { components } from "@octokit/openapi-types";

export type NotificationThread = components["schemas"]["thread"];

export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
}
