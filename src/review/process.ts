import { CursorAgentError } from "@cursor/sdk";
import { withPrLock, withPrWorkspace } from "../git/workspace.js";
import { isReviewRequestedForUser } from "../github/pr.js";
import { postGithubReview } from "../github/reviews.js";
import type { PullRequestRef } from "../types.js";
import { runAgentReview } from "./agent.js";
import { buildGithubReview } from "./payload.js";

/**
 * Core full PR review. No thread-reply knowledge.
 * CLI uses `processPrReviewWithThreadReplies` from `thread-replies/` when that
 * feature is enabled; call this directly to run reviews without it.
 */
export async function processPrReview(
  pr: PullRequestRef,
  options: { githubToken: string; cursorApiKey: string },
): Promise<boolean> {
  try {
    return await withPrLock(pr.owner, pr.repo, pr.prNumber, async () => {
      const requested = await isReviewRequestedForUser(options.githubToken, pr);
      if (!requested) {
        console.log("  Skipping: review not requested for this user");
        return true;
      }

      console.log(`  Cloning ${pr.owner}/${pr.repo}...`);
      return withPrWorkspace(
        pr.owner,
        pr.repo,
        pr.prNumber,
        options.githubToken,
        async (repoDir) => {
          console.log(`  Reviewing ${pr.prUrl} ...`);
          const payload = await runAgentReview(
            repoDir,
            pr.prUrl,
            options.cursorApiKey,
          );
          const review = buildGithubReview(payload);
          console.log(`  Verdict: ${review.event}`);
          console.log(`  ${review.comments.length} inline comment(s)`);
          await postGithubReview(options.githubToken, pr, review);
          return true;
        },
      );
    });
  } catch (err) {
    logReviewError(err);
    return false;
  }
}

export function logReviewError(err: unknown): void {
  if (err instanceof CursorAgentError) {
    console.error(`  Review startup failed: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    throw err;
  }
}
