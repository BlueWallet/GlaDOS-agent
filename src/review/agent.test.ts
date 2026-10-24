import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_DRAFT_MODEL,
  REVIEW_VERIFY_MODEL,
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
    assert.equal(REVIEW_DRAFT_MODEL, "auto");
    assert.equal(REVIEW_VERIFY_MODEL, "auto");
    assert.equal(reviewDraftModel(), "auto");
    assert.equal(reviewModelParams(REVIEW_DRAFT_MODEL), undefined);
    assert.equal(reviewVerifyModel(), "auto");

    process.env.GLADOS_REVIEW_MODEL = "composer-2.5-fast";
    process.env.GLADOS_VERIFY_MODEL = "claude-opus-5";
    assert.equal(reviewDraftModel(), "composer-2.5-fast");
    assert.equal(reviewModelParams("composer-2.5-fast"), undefined);
    assert.equal(reviewVerifyModel(), "claude-opus-5");

    process.env.GLADOS_REVIEW_MODEL = "grok-4.7";
    assert.equal(reviewDraftModel(), "grok-4.7");
    assert.deepEqual(reviewModelParams("grok-4.7"), [
      { id: "reasoning_effort", value: "xhigh" },
      { id: "fast", value: "true" },
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
    "  draft: model=grok-4.7(reasoning_effort=xhigh,fast=true) tokens=1200/340/1590 request=req-1",
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
