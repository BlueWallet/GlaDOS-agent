import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitError } from "@cursor/sdk";
import {
  REVIEW_DRAFT_MODEL,
  REVIEW_VERIFY_MODEL,
  StepTally,
  isRetryableSecondPassError,
  retrySecondPass,
  reviewDisallowedTools,
  agentRunFailureMessage,
  formatAgentRunLog,
  reviewDraftModel,
  reviewModelParams,
  reviewVerifyModel,
  withSanitizedAgentEnvironment,
} from "./agent.js";

test("agent environment hides ambient credentials and restores them", async () => {
  const oldToken = process.env.GLADOS_TOKEN;
  const oldKey = process.env.CURSOR_API_KEY;
  const oldDatabase = process.env.DATABASE_URL;
  const oldPath = process.env.PATH;
  process.env.GLADOS_TOKEN = "github-secret";
  process.env.CURSOR_API_KEY = "cursor-secret";
  process.env.DATABASE_URL = "postgres://secret";

  try {
    await withSanitizedAgentEnvironment(
      async () => {
        assert.equal(process.env.GLADOS_TOKEN, undefined);
        assert.equal(process.env.CURSOR_API_KEY, undefined);
        assert.equal(process.env.DATABASE_URL, undefined);
        assert.equal(process.env.HOME, "/tmp/disposable-home");
        assert.equal(process.env.PATH, oldPath);
      },
      { HOME: "/tmp/disposable-home" },
    );
    assert.equal(process.env.GLADOS_TOKEN, "github-secret");
    assert.equal(process.env.CURSOR_API_KEY, "cursor-secret");
  } finally {
    restoreEnv("GLADOS_TOKEN", oldToken);
    restoreEnv("CURSOR_API_KEY", oldKey);
    restoreEnv("DATABASE_URL", oldDatabase);
  }
});

test("review models default and honor env overrides", () => {
  const oldReview = process.env.GLADOS_REVIEW_MODEL;
  const oldVerify = process.env.GLADOS_VERIFY_MODEL;
  try {
    delete process.env.GLADOS_REVIEW_MODEL;
    delete process.env.GLADOS_VERIFY_MODEL;
    assert.equal(REVIEW_DRAFT_MODEL, "grok-4.7");
    assert.equal(REVIEW_VERIFY_MODEL, "grok-4.7");
    assert.equal(reviewDraftModel(), "grok-4.7");
    assert.deepEqual(reviewModelParams(REVIEW_DRAFT_MODEL, "low"), [
      { id: "reasoning_effort", value: "low" },
      { id: "fast", value: "false" },
    ]);
    assert.equal(reviewVerifyModel(), "grok-4.7");
    assert.deepEqual(reviewModelParams(REVIEW_VERIFY_MODEL, "xhigh"), [
      { id: "reasoning_effort", value: "xhigh" },
      { id: "fast", value: "false" },
    ]);

    process.env.GLADOS_REVIEW_MODEL = "composer-2.5-fast";
    process.env.GLADOS_VERIFY_MODEL = "claude-opus-5";
    assert.equal(reviewDraftModel(), "composer-2.5-fast");
    assert.equal(reviewModelParams("composer-2.5-fast", "low"), undefined);
    assert.equal(reviewVerifyModel(), "claude-opus-5");

    process.env.GLADOS_REVIEW_MODEL = "grok-4.7";
    assert.equal(reviewDraftModel(), "grok-4.7");
    assert.deepEqual(reviewModelParams("grok-4.7", "low"), [
      { id: "reasoning_effort", value: "low" },
      { id: "fast", value: "false" },
    ]);
  } finally {
    restoreEnv("GLADOS_REVIEW_MODEL", oldReview);
    restoreEnv("GLADOS_VERIFY_MODEL", oldVerify);
  }
});

test("failed agent runs include the SDK error message", () => {
  assert.equal(
    agentRunFailureMessage("Review", {
      status: "error",
      id: "run-1",
      error: { message: "Invalid parameters for registry model" },
    }),
    "Review error: run-1: Invalid parameters for registry model",
  );
  assert.equal(
    agentRunFailureMessage("Review", { status: "cancelled", id: "run-2" }),
    "Review cancelled: run-2",
  );
  assert.equal(
    agentRunFailureMessage("Review", {
      status: "error",
      id: "run-3",
      error: { message: "You're out of usage.", code: "usage_limit" },
    }),
    "Review error: run-3: [usage_limit] You're out of usage.",
  );
});

test("agent run log shows resolved model, token usage, and request id", () => {
  assert.equal(
    formatAgentRunLog("draft", {
      status: "finished",
      model: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "xhigh" }, { id: "fast", value: "true" }] },
      usage: {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        totalTokens: 1590,
      },
      requestId: "req-1",
    }),
    "  draft: model=grok-4.7(reasoning_effort=xhigh,fast=true) tokens=in=1200 out=340 cache_read=50 cache_write=0 total=1590 request=req-1",
  );
  assert.equal(
    formatAgentRunLog("verify", { status: "error" }),
    "  verify: model=? tokens=? request=? status=error",
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("step tally counts tool calls by type", () => {
  const tally = new StepTally();
  tally.add({ type: "assistantMessage", message: { text: "hi" } } as never);
  tally.add({ type: "toolCall", message: { type: "grep" } } as never);
  tally.add({ type: "toolCall", message: { type: "read" } } as never);
  tally.add({ type: "toolCall", message: { type: "read" } } as never);
  assert.equal(tally.format(), "steps=4 tool_calls=3 (read=2 grep=1)");
});

test("review disallows write tools and accepts env additions", () => {
  const old = process.env.GLADOS_DISALLOW_TOOLS;
  try {
    delete process.env.GLADOS_DISALLOW_TOOLS;
    assert.ok(
      reviewDisallowedTools().includes("task"),
      "task must be banned by default",
    );

    process.env.GLADOS_DISALLOW_TOOLS = "webFetch,edit";
    const tools = reviewDisallowedTools();
    for (const name of ["edit", "delete", "webSearch", "task", "webFetch"]) {
      assert.ok(tools.includes(name), name);
    }
    assert.equal(tools.filter((name) => name === "edit").length, 1);
  } finally {
    restoreEnv("GLADOS_DISALLOW_TOOLS", old);
  }
});

const USAGE_LIMIT =
  "Review error: run-x: You've hit your usage limit You've saved $3126 on API model usage this month with Ultra.";

function quietRetry<T>(run: () => Promise<T>, delays: number[] = [1, 2]) {
  const waits: number[] = [];
  const originalError = console.error;
  console.error = () => {};
  const promise = retrySecondPass("verify", run, delays, async (ms) => {
    waits.push(ms);
  }).finally(() => {
    console.error = originalError;
  });
  return { promise, waits };
}

test("second pass retries a transient failure and keeps the result", async () => {
  let calls = 0;
  const { promise, waits } = quietRetry(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("Review error: run-1: Agent turn stopped after repeated resume attempts made no progress");
    }
    return "verified";
  });
  assert.equal(await promise, "verified");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1]);
});

test("second pass does not retry the usage limit", async () => {
  for (const err of [new Error(USAGE_LIMIT), new RateLimitError("Too many requests")]) {
    let calls = 0;
    const { promise, waits } = quietRetry(async () => {
      calls += 1;
      throw err;
    });
    await assert.rejects(promise, err);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }
});

test("second pass gives up after the bounded retries", async () => {
  let calls = 0;
  const { promise, waits } = quietRetry(async () => {
    calls += 1;
    throw new Error(`attempt ${calls}`);
  });
  await assert.rejects(promise, /attempt 3/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2]);
});

test("retryable classification", () => {
  assert.equal(isRetryableSecondPassError(new Error("Agent returned empty review")), true);
  assert.equal(isRetryableSecondPassError(new SyntaxError("Unexpected token")), true);
  assert.equal(isRetryableSecondPassError(new Error(USAGE_LIMIT)), false);
});
