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
