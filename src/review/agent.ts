import { Agent } from "@cursor/sdk";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  buildReviewPrompt,
  parseReviewResult,
  type ReviewPayload,
} from "./payload.js";

export async function runAgentReview(
  repoDir: string,
  prUrl: string,
  cursorApiKey: string,
  extraContext = "",
): Promise<ReviewPayload> {
  const result = await promptLocalAgent(
    buildReviewPrompt(prUrl, extraContext),
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

/**
 * Shared local Cursor SDK prompt entry. Features outside this module may call
 * this; they own their own prompts and result parsing.
 */
export async function promptLocalAgent(
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
