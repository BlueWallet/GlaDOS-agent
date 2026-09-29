import type { ReviewThread } from "../github/threads.js";
import { agentRunFailureMessage, promptLocalAgent } from "../review/agent.js";
import {
  buildThreadReplyPrompt,
  parseThreadReplyResult,
  validateThreadReplyDecisions,
  type ThreadReplyDecision,
} from "./logic.js";

export async function runThreadReplies(
  repoDir: string,
  prUrl: string,
  threads: ReviewThread[],
  cursorApiKey: string,
): Promise<ThreadReplyDecision[]> {
  if (threads.length === 0) return [];

  const result = await promptLocalAgent(
    buildThreadReplyPrompt(prUrl, threads),
    repoDir,
    cursorApiKey,
  );

  if (result.status !== "finished") {
    throw new Error(agentRunFailureMessage("Thread reply agent", result));
  }

  const raw = result.result?.trim();
  if (!raw) {
    throw new Error("Agent returned empty thread replies");
  }

  try {
    const decisions = parseThreadReplyResult(raw);
    validateThreadReplyDecisions(
      decisions,
      threads.map((thread) => thread.id),
    );
    return decisions;
  } catch (err) {
    console.error("Could not parse thread reply JSON:");
    console.log(raw);
    throw err;
  }
}
