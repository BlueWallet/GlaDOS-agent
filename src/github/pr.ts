import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";

export function subjectUrlToWebUrl(subjectUrl: string): string {
  return subjectUrl
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/");
}

/** Open PRs where the authenticated user has a pending review request. */
export async function listReviewRequestedPullRequests(
  githubToken: string,
): Promise<PullRequestRef[]> {
  const octokit = github.getOctokit(githubToken);
  const items = await octokit.paginate(
    octokit.rest.search.issuesAndPullRequests,
    { q: "is:open is:pr review-requested:@me", per_page: 100 },
  );

  const prs: PullRequestRef[] = [];
  for (const item of items) {
    if (!item.pull_request) continue;
    const match = item.repository_url.match(/\/repos\/([^/]+)\/([^/]+)$/);
    if (!match) continue;
    const [, owner, repo] = match;
    prs.push({
      owner,
      repo,
      prNumber: item.number,
      prUrl: item.html_url,
    });
  }
  return prs;
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
