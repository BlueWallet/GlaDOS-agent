import { CursorAgentError } from "@cursor/sdk";
import { withPrLock, withPrWorkspace } from "../git/workspace.js";
import {
  getAuthenticatedLogin,
  getReviewThread,
  listReviewThreads,
  replyToReviewThread,
  resolveReviewThread,
  type ReviewThread,
} from "../github/threads.js";
import type { PullRequestRef } from "../types.js";
import { runThreadReplies } from "./agent.js";
import {
  assertCurrentThreadSnapshots,
  formatReplyBody,
  isAwaitingThread,
  isResolutionPending,
  listSettledFindings,
  needsResolveRetry,
  type SettledFinding,
} from "./threads.js";

export interface ThreadProcessResult {
  settled: SettledFinding[];
  complete: boolean;
}

interface ThreadState {
  login: string;
  threads: ReviewThread[];
}

interface ThreadOptions {
  githubToken: string;
  cursorApiKey: string;
  repoDir?: string;
}

/** Phase A against an existing checkout. */
export async function processReviewThreads(
  pr: PullRequestRef,
  options: ThreadOptions & { repoDir: string },
): Promise<ThreadProcessResult> {
  const state = await loadThreadState(options.githubToken, pr);
  return processThreadState(pr, options, state);
}

/**
 * Phase A only. Notifications are wake-ups, so inspect remotely first and
 * clone only if an agent reply is actually needed.
 */
export async function processPrThreadReplies(
  pr: PullRequestRef,
  options: Omit<ThreadOptions, "repoDir">,
): Promise<boolean> {
  try {
    return await withPrLock(pr.owner, pr.repo, pr.prNumber, () =>
      processPrThreadRepliesUnlocked(pr, options),
    );
  } catch (err) {
    logThreadError(err);
    return false;
  }
}

async function processPrThreadRepliesUnlocked(
  pr: PullRequestRef,
  options: Omit<ThreadOptions, "repoDir">,
): Promise<boolean> {
  const state = await loadThreadState(options.githubToken, pr);
  const awaiting = state.threads.some((thread) =>
    isAwaitingThread(thread, state.login),
  );
  if (!awaiting) {
    return (await processThreadState(pr, options, state)).complete;
  }

  console.log(`  Cloning ${pr.owner}/${pr.repo} for thread replies...`);
  const result = await withPrWorkspace(
    pr.owner,
    pr.repo,
    pr.prNumber,
    options.githubToken,
    (repoDir) => processThreadState(pr, { ...options, repoDir }, state),
  );
  return result.complete;
}

async function processThreadState(
  pr: PullRequestRef,
  options: ThreadOptions,
  state: ThreadState,
): Promise<ThreadProcessResult> {
  const { login, threads } = state;
  const settledById = new Map(
    listSettledFindings(threads, login).map((item) => [item.threadId, item]),
  );
  let complete = await retryPendingResolutions(
    threads,
    login,
    options.githubToken,
  );

  const awaiting = threads.filter((thread) =>
    isAwaitingThread(thread, login),
  );
  if (awaiting.length === 0) {
    console.log("  No review threads awaiting a reply");
    return { settled: [...settledById.values()], complete };
  }
  if (!options.repoDir) {
    throw new Error("Thread replies require a prepared PR workspace");
  }

  console.log(`  ${awaiting.length} thread(s) awaiting reply...`);
  const decisions = await runThreadReplies(
    options.repoDir,
    pr.prUrl,
    awaiting,
    options.cursorApiKey,
  );

  const snapshotsById = new Map(
    awaiting.map((thread) => [thread.id, thread]),
  );

  for (const decision of decisions) {
    // Re-fetch immediately before each write. Earlier replies in this batch do
    // not make later decisions safe if their discussions changed meanwhile.
    const snapshot = snapshotsById.get(decision.threadId);
    if (!snapshot) {
      throw new Error(`Missing thread snapshot: ${decision.threadId}`);
    }
    const thread = await getReviewThread(
      options.githubToken,
      decision.threadId,
    );
    assertCurrentThreadSnapshots(
      [snapshot],
      thread ? [thread] : [],
      login,
    );
    if (!thread) {
      throw new Error(`Thread disappeared before reply: ${decision.threadId}`);
    }
    const result = await applyThreadDecision(
      options.githubToken,
      thread,
      decision,
      login,
    );
    if (result.settled) {
      settledById.set(result.settled.threadId, result.settled);
    }
    if (!result.complete) complete = false;
  }

  return { settled: [...settledById.values()], complete };
}

async function retryPendingResolutions(
  threads: ReviewThread[],
  login: string,
  githubToken: string,
): Promise<boolean> {
  let complete = true;
  for (const thread of threads) {
    if (!isResolutionPending(thread, login)) continue;
    if (!thread.viewerCanResolve) {
      logCannotResolve(thread.id);
      complete = false;
      continue;
    }
    if (!needsResolveRetry(thread, login)) continue;
    console.log(`  Retrying resolve on agreed thread ${thread.id}`);
    if (!(await tryResolveThread(githubToken, thread.id))) complete = false;
  }
  return complete;
}

async function applyThreadDecision(
  githubToken: string,
  thread: ReviewThread,
  decision: { decision: "agree" | "disagree"; body: string },
  login: string,
): Promise<{ settled?: SettledFinding; complete: boolean }> {
  const root = thread.comments[0];
  if (!root) throw new Error(`Thread ${thread.id} has no comments`);
  const replyTo = thread.comments.at(-1);
  if (!replyTo) throw new Error(`Thread ${thread.id} has no reply target`);

  await replyToReviewThread(
    githubToken,
    thread.id,
    formatReplyBody(decision.decision, decision.body, replyTo.id),
  );
  console.log(`  Replied (${decision.decision}) on ${thread.path}`);

  const updated = await getReviewThread(githubToken, thread.id);
  if (!updated) throw new Error(`Thread disappeared after reply: ${thread.id}`);

  if (decision.decision === "disagree") {
    const complete = !isAwaitingThread(updated, login);
    if (!complete) {
      console.error(`  Thread ${thread.id} changed while posting; retrying later`);
    }
    return { complete };
  }

  const settled = listSettledFindings([updated], login)[0];
  if (!settled) {
    console.error(
      `  Agreement on ${thread.id} did not cover the latest reply; retrying later`,
    );
    return { complete: false };
  }
  if (!updated.viewerCanResolve) {
    logCannotResolve(thread.id);
    return { settled, complete: false };
  }

  return {
    settled,
    complete: await tryResolveThread(githubToken, thread.id),
  };
}

async function tryResolveThread(
  githubToken: string,
  threadId: string,
): Promise<boolean> {
  try {
    await resolveReviewThread(githubToken, threadId);
    console.log(`  Resolved thread ${threadId}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Could not resolve thread ${threadId}: ${message}`);
    return false;
  }
}

async function loadThreadState(
  githubToken: string,
  pr: PullRequestRef,
): Promise<ThreadState> {
  const [login, threads] = await Promise.all([
    getAuthenticatedLogin(githubToken),
    listReviewThreads(githubToken, pr),
  ]);
  return { login, threads };
}

function logCannotResolve(threadId: string): void {
  console.error(
    `  Cannot resolve agreed thread ${threadId}: GitHub requires PR author or repository write access`,
  );
}

function logThreadError(err: unknown): void {
  if (err instanceof CursorAgentError) {
    console.error(`  Thread reply startup failed: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    throw err;
  }
}
