import * as github from "@actions/github";
import type { NotificationThread, PullRequestRef } from "../types.js";

export function parsePullRequest(
  notification: NotificationThread,
): PullRequestRef | null {
  const subjectUrl = notification.subject?.url;
  if (!subjectUrl) return null;

  const match = subjectUrl.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
  if (!match) return null;

  const [, owner, repo, prNumberStr] = match;
  return {
    owner,
    repo,
    prNumber: Number(prNumberStr),
    prUrl: `https://github.com/${owner}/${repo}/pull/${prNumberStr}`,
  };
}

export function subjectUrlToWebUrl(subjectUrl: string): string {
  return subjectUrl
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/");
}

/** Whether the authenticated user is on the PR's pending reviewer list. */
export async function isReviewRequestedForUser(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<boolean> {
  const octokit = github.getOctokit(githubToken);
  const [{ data: user }, { data: requested }] = await Promise.all([
    octokit.rest.users.getAuthenticated(),
    octokit.rest.pulls.listRequestedReviewers({
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.prNumber,
    }),
  ]);

  return requested.users.some((u) => u.login === user.login);
}
