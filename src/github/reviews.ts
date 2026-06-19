import * as github from "@actions/github";
import { RequestError } from "@octokit/request-error";
import {
  appendCommentsToBody,
  buildGithubReview,
} from "../review/payload.js";
import type { PullRequestRef } from "../types.js";
import { getCommentableLines } from "./diff.js";

type ReviewComment = ReturnType<typeof buildGithubReview>["comments"][number];

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

  // Only lines that actually appear in the PR diff are commentable; anything
  // else 422s and would poison the whole inline batch. Split accordingly.
  const commentable = await getCommentableLines(octokit, pr);
  const { anchored, demoted } = splitByCommentable(review.comments, commentable);

  if (demoted.length > 0) {
    console.error(
      `  ${demoted.length} comment(s) not on the diff — moved to review body`,
    );
  }

  const body =
    demoted.length > 0 ? appendCommentsToBody(review.body, demoted) : review.body;

  const baseParams = {
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.prNumber,
    commit_id: pull.head.sha,
    event: review.event,
    body,
  };

  try {
    const { data } = await octokit.rest.pulls.createReview({
      ...baseParams,
      comments: anchored.length > 0 ? anchored : undefined,
    });
    console.log(
      `  Posted ${review.event} review (${anchored.length} inline): ${data.html_url}`,
    );
    return;
  } catch (err) {
    if (!(err instanceof RequestError) || err.status !== 422 || anchored.length === 0) {
      throw err;
    }

    // Safety net: validation should make this unreachable, but if GitHub still
    // rejects the inline batch, fall back to a body-only review rather than lose
    // the findings entirely.
    console.error("  Inline batch still rejected, posting body-only...");
    const { data } = await octokit.rest.pulls.createReview({
      ...baseParams,
      body: appendCommentsToBody(body, anchored),
    });
    console.log(`  Posted ${review.event} review (no inline): ${data.html_url}`);
  }
}

function splitByCommentable(
  comments: ReviewComment[],
  commentable: Map<string, Set<number>>,
): { anchored: ReviewComment[]; demoted: ReviewComment[] } {
  const anchored: ReviewComment[] = [];
  const demoted: ReviewComment[] = [];

  for (const comment of comments) {
    if (commentable.get(comment.path)?.has(comment.line)) {
      anchored.push(comment);
    } else {
      demoted.push(comment);
    }
  }

  return { anchored, demoted };
}
