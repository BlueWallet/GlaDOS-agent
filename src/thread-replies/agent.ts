import type { IssueComment } from "../github/comments.js";
import type { ReviewThread } from "../github/threads.js";
import { agentRunFailureMessage, promptLocalAgent } from "../review/agent.js";
import {
  buildThreadReplyPrompt,
  parseThreadReplyResult,
  threadReplyKind,
  validateThreadReplyDecisions,
  type ThreadReplyDecision,
} from "./logic.js";
import { buildMentionReplyPrompt, parseMentionReplyResult } from "./mentions.js";

export async function runThreadReplies(
  repoDir: string,
  prUrl: string,
  threads: ReviewThread[],
  cursorApiKey: string,
  gladosLogin: string,
): Promise<ThreadReplyDecision[]> {
  if (threads.length === 0) return [];

  const raw = await runPrompt(
    "Thread reply agent",
    buildThreadReplyPrompt(prUrl, threads, gladosLogin),
    repoDir,
    cursorApiKey,
  );

  try {
    const decisions = parseThreadReplyResult(raw);
    validateThreadReplyDecisions(
      decisions,
      threads.map((thread) => ({
        threadId: thread.id,
        kind: threadReplyKind(thread, gladosLogin),
      })),
    );
    return decisions;
  } catch (err) {
    console.error("Could not parse thread reply JSON:");
    console.log(raw);
    throw err;
  }
}

export async function runMentionReply(
  repoDir: string,
  prUrl: string,
  prContextBlock: string,
  awaiting: IssueComment[],
  cursorApiKey: string,
): Promise<string> {
  const raw = await runPrompt(
    "Mention reply agent",
    buildMentionReplyPrompt(prUrl, prContextBlock, awaiting),
    repoDir,
    cursorApiKey,
  );

  try {
    return parseMentionReplyResult(raw);
  } catch (err) {
    console.error("Could not parse mention reply JSON:");
    console.log(raw);
    throw err;
  }
}

async function runPrompt(
  label: string,
  prompt: string,
  repoDir: string,
  cursorApiKey: string,
): Promise<string> {
  const result = await promptLocalAgent(prompt, repoDir, cursorApiKey);
  if (result.status !== "finished") {
    throw new Error(agentRunFailureMessage(label, result));
  }
  const raw = result.result?.trim();
  if (!raw) {
    throw new Error(`${label} returned empty output`);
  }
  return raw;
}
