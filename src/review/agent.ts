import {
  Agent,
  AuthenticationError,
  ConfigurationError,
  RateLimitError,
  type ConversationStep,
  type RunResult,
  type ToolName,
} from "@cursor/sdk";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  buildReviewPrompt,
  buildVerifyPrompt,
  buildVoicePrompt,
  formatPrContext,
  mergeVerifiedFindings,
  parseReviewResult,
  parseVerifiedReviewResult,
  type PrContext,
  type ReviewPayload,
  undisprovenBlockers,
} from "./payload.js";

/**
 * Tools a read-only review never needs. Removing them shrinks the tool schema
 * sent every turn and blocks wasted turns (web search, file edits, images,
 * and task subagents that re-explore the repo and burn tokens).
 * GLADOS_DISALLOW_TOOLS (comma-separated, e.g. "webFetch") adds more for A/B runs.
 */
export const REVIEW_DISALLOWED_TOOLS: ToolName[] = [
  "edit",
  "delete",
  "applyAgentDiff",
  "generateImage",
  "webSearch",
  "askQuestion",
  "task",
];

export function reviewDisallowedTools(): ToolName[] {
  const extra = (process.env.GLADOS_DISALLOW_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set([...REVIEW_DISALLOWED_TOOLS, ...extra])];
}

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
  prContext?: PrContext,
): Promise<ReviewPayload> {
  const draftModel = reviewDraftModel();
  const draftParams = reviewModelParams(draftModel);
  const draftLabel = formatModelLabel(draftModel, draftParams);
  console.log(`  Draft review (${draftLabel})...`);
  const drafted = await runReviewPass(
    buildReviewPrompt(prUrl, extraContext, formatPrContext(prContext)),
    repoDir,
    cursorApiKey,
    draftModel,
    "draft",
    parseReviewResult,
  );
  const draft = filterDraft(drafted);
  if (draft.findings.length === 0) {
    console.log(`  Voice review (${draftLabel})...`);
    const voiced = await retrySecondPass("voice", () =>
      runReviewPass(
        buildVoicePrompt(prUrl, draft),
        repoDir,
        cursorApiKey,
        draftModel,
        "voice",
        parseReviewResult,
      ),
    );
    return { summary: voiced.summary, findings: [] };
  }

  const verifyModel = reviewVerifyModel();
  const verifyParams = reviewModelParams(verifyModel);
  const verifyLabel = formatModelLabel(verifyModel, verifyParams);
  console.log(`  Verify review (${verifyLabel}, ${draft.findings.length} candidate(s))...`);
  const verified = await retrySecondPass("verify", () =>
    runReviewPass(
      buildVerifyPrompt(
        prUrl,
        draft,
        extraContext,
        formatPrContext(prContext, { includeDiff: false }),
      ),
      repoDir,
      cursorApiKey,
      verifyModel,
      "verify",
      parseVerifiedReviewResult,
    ),
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

/** Retries after a failed voice/verify pass: short waits, then give up. */
export const SECOND_PASS_RETRY_DELAYS_MS = [15_000, 45_000];

/**
 * Usage limits, auth, and bad config will fail the same way again; everything
 * else (run errors such as "resume attempts made no progress", network blips,
 * empty or unparsable output) is worth another try.
 */
export function isRetryableSecondPassError(err: unknown): boolean {
  if (err instanceof RateLimitError) return false;
  if (err instanceof AuthenticationError) return false;
  if (err instanceof ConfigurationError) return false;
  const message = err instanceof Error ? err.message : String(err);
  return !/usage limit/i.test(message);
}

/**
 * Re-run only the second pass. The caller's closure captures the in-memory
 * draft, so the expensive draft pass is never repeated.
 */
export async function retrySecondPass<T>(
  label: string,
  run: () => Promise<T>,
  delaysMs: readonly number[] = SECOND_PASS_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      const delay = delaysMs[attempt];
      if (delay === undefined || !isRetryableSecondPassError(err)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `  ${label} pass failed (${reason}); retry ${attempt + 1}/${delaysMs.length} in ${Math.round(delay / 1000)}s, keeping the draft`,
      );
      await sleep(delay);
    }
  }
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
  const tokens = usage
    ? `in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadTokens} cache_write=${usage.cacheWriteTokens} total=${usage.totalTokens}`
    : "?";
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
  const tally = new StepTally();
  const result = await withSanitizedAgentEnvironment(
    async () => {
      // Same as Agent.prompt(), but with onStep so each pass logs its tool mix.
      const agent = await Agent.create({
        apiKey: cursorApiKey,
        model: modelParams ? { id: modelId, params: modelParams } : { id: modelId },
        disallowedTools: reviewDisallowedTools(),
        local: {
          cwd: workspaceDir,
          settingSources: [],
          // Off: GitHub Actions (and many Linux hosts) fail sandbox preflight.
          sandboxOptions: { enabled: false },
        },
      });
      try {
        const run = await agent.send(scopedPrompt, {
          onStep: ({ step }) => tally.add(step),
        });
        return await run.wait();
      } finally {
        await agent[Symbol.asyncDispose]();
      }
    },
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
  console.log(`  ${label}: ${tally.format()}`);
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

/** Counts conversation steps per tool so slow passes can be attributed. */
export class StepTally {
  private steps = 0;
  private readonly tools = new Map<string, number>();

  add(step: ConversationStep): void {
    this.steps += 1;
    if (step.type !== "toolCall") return;
    const name = (step.message as { type?: string }).type ?? "unknown";
    this.tools.set(name, (this.tools.get(name) ?? 0) + 1);
  }

  format(): string {
    const calls = [...this.tools.values()].reduce((sum, count) => sum + count, 0);
    const mix = [...this.tools.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
    return `steps=${this.steps} tool_calls=${calls}${mix ? ` (${mix})` : ""}`;
  }
}
