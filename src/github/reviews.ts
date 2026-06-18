import * as github from "@actions/github";
import { RequestError } from "@octokit/request-error";
import {
  appendCommentsToBody,
  buildGithubReview,
} from "../review/payload.js";
import type { PullRequestRef } from "../types.js";

export async function postGithubReview(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
  review: ReturnType<typeof buildGithubReview>,
): Promise<void> {
  const octokit = github.getOctokit(githubToken);
  const { data: pull } = await octokit.rest.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.prNumber,
  });

  const baseParams = {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.prNumber,
    commit_id: pull.head.sha,
    event: review.event,
    body: review.body,
  };

  try {
    const { data } = await octokit.rest.pulls.createReview({
      ...baseParams,
      comments: review.comments.length > 0 ? review.comments : undefined,
    });
    console.log(`Posted ${review.event} review: ${data.html_url}`);
    return;
  } catch (err) {
    if (
      !(err instanceof RequestError) ||
      err.status !== 422 ||
      review.comments.length === 0
    ) {
      throw err;
    }

    console.error("Inline comments rejected, posting summary only...");
    const body = appendCommentsToBody(review.body, review.comments);
    const { data } = await octokit.rest.pulls.createReview({
      ...baseParams,
      body,
    });
    console.log(`Posted ${review.event} review (no inline): ${data.html_url}`);
  }
}
