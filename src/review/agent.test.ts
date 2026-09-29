import assert from "node:assert/strict";
import test from "node:test";
import {
  REVIEW_DRAFT_MODEL,
  REVIEW_VERIFY_MODEL,
  agentRunFailureMessage,
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
    assert.equal(reviewDraftModel(), REVIEW_DRAFT_MODEL);
    assert.deepEqual(reviewModelParams(REVIEW_DRAFT_MODEL), [
      { id: "reasoning_effort", value: "xhigh" },
      { id: "fast", value: "false" },
    ]);
    assert.equal(reviewVerifyModel(), REVIEW_VERIFY_MODEL);

    process.env.GLADOS_REVIEW_MODEL = "composer-2.5-fast";
    process.env.GLADOS_VERIFY_MODEL = "claude-opus-5";
    assert.equal(reviewDraftModel(), "composer-2.5-fast");
    assert.equal(reviewModelParams("composer-2.5-fast"), undefined);
    assert.equal(reviewVerifyModel(), "claude-opus-5");
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
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
