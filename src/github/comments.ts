import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";

export interface IssueComment {
  id: string;
  authorLogin: string;
  authorIsBot: boolean;
  body: string;
  createdAt: string;
}

/** Fully paginated PR conversation (issue) comments. */
export async function listIssueComments(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
): Promise<IssueComment[]> {
  const octokit = github.getOctokit(githubToken);
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner: pr.owner,
    repo: pr.repo,
    issue_number: pr.prNumber,
    per_page: 100,
  });
  return comments.map((comment) => ({
    id: String(comment.id),
    authorLogin: comment.user?.login ?? "",
    authorIsBot: comment.user?.type === "Bot",
    body: comment.body ?? "",
    createdAt: comment.created_at,
  }));
}
