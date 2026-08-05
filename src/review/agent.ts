import { Agent } from "@cursor/sdk";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ReviewThread } from "../github/threads.js";
import {
  buildReviewPrompt,
  parseReviewResult,
  type ReviewPayload,
} from "./payload.js";
import {
  buildThreadReplyPrompt,
  parseThreadReplyResult,
  validateThreadReplyDecisions,
  type ThreadReplyDecision,
} from "./threads.js";

export async function runAgentReview(
  repoDir: string,
  prUrl: string,
  cursorApiKey: string,
  settledContext = "",
): Promise<ReviewPayload> {
  const result = await promptAgent(
    buildReviewPrompt(prUrl, settledContext),
    repoDir,
    cursorApiKey,
  );

  if (result.status !== "finished") {
    throw new Error(`Review ${result.status}: ${result.id}`);
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

export async function runThreadReplies(
  repoDir: string,
  prUrl: string,
  threads: ReviewThread[],
  cursorApiKey: string,
): Promise<ThreadReplyDecision[]> {
  if (threads.length === 0) return [];

  const result = await promptAgent(
    buildThreadReplyPrompt(prUrl, threads),
    repoDir,
    cursorApiKey,
  );

  if (result.status !== "finished") {
    throw new Error(`Thread reply agent ${result.status}: ${result.id}`);
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

async function promptAgent(
  prompt: string,
  repoDir: string,
  cursorApiKey: string,
) {
  // Use the temp parent as the Cursor workspace. Repository-controlled
  // .cursor/sandbox.json then remains review data, not active sandbox policy.
  const workspaceDir = dirname(repoDir);
  const repoName = basename(repoDir);
  const agentHome = join(workspaceDir, ".agent-home");
  const agentTmp = join(workspaceDir, ".agent-tmp");
  await Promise.all([
    mkdir(agentHome, { recursive: true }),
    mkdir(agentTmp, { recursive: true }),
  ]);
  const scopedPrompt = [
    `The checked-out repository root is ./${repoName}. Run all repository and git operations inside that directory.`,
    "",
    prompt,
  ].join("\n");

  return withSanitizedAgentEnvironment(
    () =>
      Agent.prompt(scopedPrompt, {
        apiKey: cursorApiKey,
        model: { id: "composer-2.5" },
        local: {
          cwd: workspaceDir,
          settingSources: [],
          sandboxOptions: { enabled: true },
        },
      }),
    {
      HOME: agentHome,
      USERPROFILE: agentHome,
      XDG_CONFIG_HOME: join(agentHome, ".config"),
      XDG_CACHE_HOME: join(agentHome, ".cache"),
      TMPDIR: agentTmp,
      TMP: agentTmp,
      TEMP: agentTmp,
    },
  );
}

/**
 * The local agent inherits this process environment. Remove ambient
 * credentials for the duration of the run; the Cursor key is passed explicitly.
 */
export async function withSanitizedAgentEnvironment<T>(
  run: () => Promise<T>,
  overrides: NodeJS.ProcessEnv = {},
): Promise<T> {
  const allowed = new Set([
    "COLORTERM",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
    "XDG_RUNTIME_DIR",
  ]);
  const original = { ...process.env };
  for (const name of Object.keys(process.env)) {
    delete process.env[name];
  }
  for (const name of allowed) {
    const value = original[name];
    if (value !== undefined) process.env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    for (const name of Object.keys(process.env)) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(original)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}
