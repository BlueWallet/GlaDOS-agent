import { CursorAgentError } from "@cursor/sdk";
import { rm } from "node:fs/promises";
import { preparePrWorkspace } from "../git/workspace.js";
import { parsePullRequest } from "../github/pr.js";
import { postGithubReview } from "../github/reviews.js";
import type { NotificationThread } from "../types.js";
import { runAgentReview } from "./agent.js";
import { buildGithubReview } from "./payload.js";

export async function processReviewRequest(
  notification: NotificationThread,
  options: { githubToken: string; cursorApiKey: string },
): Promise<void> {
  const pr = parsePullRequest(notification);
  if (!pr) {
    console.error("Skipping: not a pull request notification");
    return;
  }

  let workDir: string | undefined;

  try {
    console.log(`Cloning ${pr.owner}/${pr.repo}...`);
    const workspace = await preparePrWorkspace(
      pr.owner,
      pr.repo,
      pr.prNumber,
      options.githubToken,
    );
    workDir = workspace.workDir;

    console.log(`Reviewing ${pr.prUrl}...`);
    const payload = await runAgentReview(
      workspace.repoDir,
      pr.prUrl,
      options.cursorApiKey,
    );

    console.log('payload=', payload);
    return;

    const githubReview = buildGithubReview(payload);
    console.log(`Verdict: ${githubReview.event}`);
    console.log(`${githubReview.comments.length} inline comment(s)\n`);
    console.log(githubReview.body);

    await postGithubReview(options.githubToken, pr, githubReview);
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`Review startup failed: ${err.message}`);
      return;
    }
    if (err instanceof Error) {
      console.error(err.message);
      return;
    }
    throw err;
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
