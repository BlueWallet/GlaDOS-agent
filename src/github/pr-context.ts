import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as github from "@actions/github";
import type { PullRequestRef } from "../types.js";
import type { PrContext } from "../review/payload.js";

const execFileAsync = promisify(execFile);

/** Diffs at or below this size are inlined into the draft prompt. */
export const INLINE_DIFF_MAX_CHARS = 80_000;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoDir,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/**
 * Everything the agent otherwise spends turns discovering: PR metadata,
 * base/merge-base, changed-file list, and (when small) the diff itself.
 * The checkout from withPrWorkspace() is a full clone, so origin/<base> exists.
 */
export async function loadPrContext(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
  repoDir: string,
): Promise<PrContext> {
  const octokit = github.getOctokit(githubToken);
  const [{ data: pull }, files] = await Promise.all([
    octokit.rest.pulls.get({ owner: pr.owner, repo: pr.repo, pull_number: pr.prNumber }),
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.prNumber,
      per_page: 100,
    }),
  ]);

  let mergeBase = pull.base.sha;
  try {
    mergeBase = (await git(repoDir, ["merge-base", `origin/${pull.base.ref}`, "HEAD"])).trim() || mergeBase;
  } catch {
    // Fall back to the API base sha; the agent can still diff against it.
  }

  let diff: string | undefined;
  try {
    const full = await git(repoDir, ["diff", "--no-color", `${mergeBase}...HEAD`]);
    if (full.length <= INLINE_DIFF_MAX_CHARS) diff = full;
  } catch {
    diff = undefined;
  }

  return {
    title: pull.title,
    body: pull.body ?? "",
    author: pull.user?.login ?? "?",
    baseRef: pull.base.ref,
    headSha: pull.head.sha,
    mergeBase,
    files: files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    diff,
  };
}

/** Context is an optimization; never fail a review because it could not load. */
export async function tryLoadPrContext(
  githubToken: string,
  pr: Pick<PullRequestRef, "owner" | "repo" | "prNumber">,
  repoDir: string,
): Promise<PrContext | undefined> {
  try {
    const context = await loadPrContext(githubToken, pr, repoDir);
    console.log(
      `  PR context: ${context.files.length} file(s), diff ${context.diff === undefined ? "not inlined" : `${context.diff.length} chars inlined`}`,
    );
    return context;
  } catch (err) {
    console.error(`  PR context unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
