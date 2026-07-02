import { CursorAgentError } from "@cursor/sdk";
import { rm } from "node:fs/promises";
import { preparePrWorkspace } from "../git/workspace.js";
import { isReviewRequestedForUser } from "../github/pr.js";
import { postGithubReview } from "../github/reviews.js";
import type { PullRequestRef } from "../types.js";
import { runAgentReview } from "./agent.js";
import { buildGithubReview } from "./payload.js";

/** Returns true when the PR was reviewed and posted successfully. */
export async function processPrReview(
  pr: PullRequestRef,
  options: { githubToken: string; cursorApiKey: string },
): Promise<boolean> {
  let workDir: string | undefined;

  try {
    const requested = await isReviewRequestedForUser(options.githubToken, pr);
    if (!requested) {
      console.log("  Skipping: review not requested for this user");
      return true;
    }

    console.log(`  Cloning ${pr.owner}/${pr.repo}...`);
    const workspace = await preparePrWorkspace(
      pr.owner,
      pr.repo,
      pr.prNumber,
      options.githubToken,
    );
    workDir = workspace.workDir;

    console.log(`  Reviewing ${pr.prUrl}...`);
    const payload = await runAgentReview(
      workspace.repoDir,
      pr.prUrl,
      options.cursorApiKey,
    );

    const githubReview = buildGithubReview(payload);
    console.log(`  Verdict: ${githubReview.event}`);
    console.log(`  ${githubReview.comments.length} inline comment(s)`);

    await postGithubReview(options.githubToken, pr, githubReview);
    return true;
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`  Review startup failed: ${err.message}`);
      return false;
    }
    if (err instanceof Error) {
      console.error(err.message);
      return false;
    }
    throw err;
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
