import { Agent } from "@cursor/sdk";
import {
  buildReviewPrompt,
  parseReviewResult,
  type ReviewPayload,
} from "./payload.js";

export async function runAgentReview(
  repoDir: string,
  prUrl: string,
  cursorApiKey: string,
): Promise<ReviewPayload> {
  const result = await Agent.prompt(buildReviewPrompt(prUrl), {
    apiKey: cursorApiKey,
    model: { id: "composer-2.5" },
    local: { cwd: repoDir },
  });

  if (result.status === "error") {
    throw new Error(`Review failed: ${result.id}`);
  }

  const raw = result.result?.trim();
  if (!raw) {
    throw new Error("Agent returned empty review");
  }

  try {
    return parseReviewResult(raw);
  } catch (err) {
    console.error("Could not parse review JSON:");
    console.log(raw);
    throw err;
  }
}
