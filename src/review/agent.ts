import { Agent, type RunResult } from "@cursor/sdk";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  buildReviewPrompt,
  buildVerifyPrompt,
  buildVoicePrompt,
  mergeVerifiedFindings,
  parseReviewResult,
  parseVerifiedReviewResult,
  type ReviewPayload,
  undisprovenBlockers,
} from "./payload.js";

/** Cursor "Auto": the server picks the model, and it keeps working after plan usage runs out. */
export const REVIEW_DRAFT_MODEL = "auto";
export const REVIEW_VERIFY_MODEL = "auto";

export function reviewDraftModel(): string {
  return process.env.GLADOS_REVIEW_MODEL || REVIEW_DRAFT_MODEL;
}

export function reviewVerifyModel(): string {
  return process.env.GLADOS_VERIFY_MODEL || REVIEW_VERIFY_MODEL;
}

/** Grok 4.7 (only via env override) runs standard tier at xhigh. Other models, including auto, get no params. */
export function reviewModelParams(modelId: string): Array<{ id: string; value: string }> | undefined {
  if (modelId !== "grok-4.7") return undefined;
  return [
    { id: "reasoning_effort", value: "xhigh" },
    { id: "fast", value: "true" },
  ];
}

export async function runAgentReview(
  repoDir: string,
  prUrl: string,
  cursorApiKey: string,
  extraContext = "",
  filterDraft: (draft: ReviewPayload) => ReviewPayload = (draft) => draft,
): Promise<ReviewPayload> {
  const draftModel = reviewDraftModel();
  const draftParams = reviewModelParams(draftModel);
  const draftLabel = formatModelLabel(draftModel, draftParams);
  console.log(`  Draft review (${draftLabel})...`);
  const drafted = await runReviewPass(
    buildReviewPrompt(prUrl, extraContext),
    repoDir,
    cursorApiKey,
    draftModel,
    "draft",
    parseReviewResult,
  );
  const draft = filterDraft(drafted);
  if (draft.findings.length === 0) {
    console.log(`  Voice review (${draftLabel})...`);
    const voiced = await runReviewPass(
      buildVoicePrompt(prUrl, draft),
      repoDir,
      cursorApiKey,
      draftModel,
      "voice",
      parseReviewResult,
    );
    return { summary: voiced.summary, findings: [] };
  }

  const verifyModel = reviewVerifyModel();
  const verifyParams = reviewModelParams(verifyModel);
  const verifyLabel = formatModelLabel(verifyModel, verifyParams);
  console.log(`  Verify review (${verifyLabel}, ${draft.findings.length} candidate(s))...`);
  const verified = await runReviewPass(
    buildVerifyPrompt(prUrl, draft, extraContext),
    repoDir,
    cursorApiKey,
    verifyModel,
    "verify",
    parseVerifiedReviewResult,
  );
  const merged = mergeVerifiedFindings(draft, verified);
  const dropped = draft.findings.length - merged.findings.length;
  if (dropped > 0) {
    console.log(`  Verify dropped ${dropped} candidate(s)`);
  }
  for (const drop of verified.dropped ?? []) {
    const candidate = draft.findings[drop.candidate]!;
    console.log(
      `    #${drop.candidate} [${candidate.severity}] ${logSafe(candidate.path)}: ${logSafe(drop.evidence)}`,
    );
  }
  const restored = undisprovenBlockers(draft, verified).length;
  if (restored > 0) {
    console.log(`  Restored ${restored} blocker(s) dropped without evidence`);
  }
  return merged;
}

/** Model-generated text on one line: control chars escaped, format chars removed. */
function logSafe(text: string): string {
  return JSON.stringify(text.replace(/\p{Cf}/gu, ""));
}

function formatModelLabel(
  modelId: string,
  params: Array<{ id: string; value: string }> | undefined,
): string {
  if (!params?.length) return modelId;
  const detail = params.map((param) => `${param.id}=${param.value}`).join(" ");
  return `${modelId} ${detail}`;
}

export function agentRunFailureMessage(
  label: string,
  result: { status: string; id: string; error?: { message: string; code?: string } },
): string {
  const message = result.error?.message.trim();
  const code = result.error?.code?.trim();
  const detail = code ? `[${code}] ${message ?? ""}`.trim() : message;
  const base = `${label} ${result.status}: ${result.id}`;
  return detail ? `${base}: ${detail}` : base;
}

/** One log line per agent pass: server-resolved model, token usage, request id. */
export function formatAgentRunLog(
  label: string,
  result: Pick<RunResult, "status" | "model" | "usage" | "requestId">,
): string {
  const params = result.model?.params?.map((param) => `${param.id}=${param.value}`).join(",");
  const model = result.model?.id ? `${result.model.id}${params ? `(${params})` : ""}` : "?";
  const usage = result.usage;
  const tokens = usage ? `${usage.inputTokens}/${usage.outputTokens}/${usage.totalTokens}` : "?";
  const status = result.status === "finished" ? "" : ` status=${result.status}`;
  return `  ${label}: model=${model} tokens=${tokens} request=${result.requestId ?? "?"}${status}`;
}

async function runReviewPass<T>(
  prompt: string,
  repoDir: string,
  cursorApiKey: string,
  modelId: string,
  label: string,
  parse: (text: string) => T,
): Promise<T> {
  const result = await promptLocalAgent(prompt, repoDir, cursorApiKey, modelId, label);

  if (result.status !== "finished") {
    throw new Error(agentRunFailureMessage("Review", result));
  }

  const raw = result.result?.trim();
  if (!raw) {
    throw new Error("Agent returned empty review");
  }

  try {
    return parse(raw);
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
  modelId = reviewDraftModel(),
  label = "agent",
): Promise<RunResult> {
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

  const modelParams = reviewModelParams(modelId);
  const result = await withSanitizedAgentEnvironment(
    () =>
      Agent.prompt(scopedPrompt, {
        apiKey: cursorApiKey,
        model: modelParams ? { id: modelId, params: modelParams } : { id: modelId },
        local: {
          cwd: workspaceDir,
          settingSources: [],
          // Off: GitHub Actions (and many Linux hosts) fail sandbox preflight.
          sandboxOptions: { enabled: false },
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
  console.log(formatAgentRunLog(label, result));
  return result;
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
