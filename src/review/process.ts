import { CursorAgentError } from "@cursor/sdk";
import { withPrLock, withPrWorkspace } from "../git/workspace.js";
import { isReviewRequestedForUser } from "../github/pr.js";
import { postGithubReview } from "../github/reviews.js";
import type { PullRequestRef } from "../types.js";
import { runAgentReview } from "./agent.js";
import { buildGithubReview } from "./payload.js";
import { processReviewThreads } from "./thread-process.js";
import {
  formatSettledContext,
  suppressSettledFindings,
} from "./threads.js";

/** Run Phase A thread handling, then the requested full PR review. */
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
          const threadResult = await processReviewThreads(pr, {
            ...options,
            repoDir,
          });

          console.log(`  Reviewing ${pr.prUrl} ...`);
          const payload = await runAgentReview(
            repoDir,
            pr.prUrl,
            options.cursorApiKey,
            formatSettledContext(threadResult.settled),
          );
          const filtered = suppressSettledFindings(
            payload,
            threadResult.settled,
          );
          const suppressed =
            payload.findings.length - filtered.findings.length;
          if (suppressed > 0) {
            console.log(`  Suppressed ${suppressed} settled finding(s)`);
          }

          const review = buildGithubReview(filtered);
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

function logReviewError(err: unknown): void {
  if (err instanceof CursorAgentError) {
    console.error(`  Review startup failed: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    throw err;
  }
}
