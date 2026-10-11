import { CursorAgentError } from "@cursor/sdk";
import { withPrLock, withPrWorkspace } from "../git/workspace.js";
import { isReviewRequestedForUser } from "../github/pr.js";
import { fetchPrContext } from "../github/pr-context.js";
import { postGithubReview } from "../github/reviews.js";
import type { PullRequestRef } from "../types.js";
import { runAgentReview } from "./agent.js";
import { formatPrContext } from "./context.js";
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
          const prContext = await loadPrContextBlock(options.githubToken, pr);
          const payload = await runAgentReview(
            repoDir,
            pr.prUrl,
            options.cursorApiKey,
            { prContext },
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

/** Fetch and render the PR context block for the review prompts. */
export async function loadPrContextBlock(
  githubToken: string,
  pr: PullRequestRef,
): Promise<string> {
  const { text, omitted } = formatPrContext(
    await fetchPrContext(githubToken, pr),
  );
  console.log(`  PR context: ${text.length} chars, ${omitted} items omitted`);
  return text;
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
