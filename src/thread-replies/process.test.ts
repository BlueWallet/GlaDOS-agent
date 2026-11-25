import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewThread, ReviewThreadComment } from "../github/threads.js";
import { formatReplyBody, listSettledFindings } from "./logic.js";
import { loadReviewMemory } from "./process.js";

const glados = "GladosBot";

function comment(id: string, authorLogin: string, body: string, createdAt: string): ReviewThreadComment {
  return { id, authorLogin, authorIsBot: false, body, createdAt, updatedAt: createdAt };
}

function thread(id: string, comments: ReviewThreadComment[], overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id,
    isResolved: false,
    viewerCanResolve: true,
    path: "src/a.ts",
    line: 3,
    resolvedByLogin: null,
    resolvedByIsBot: false,
    comments,
    ...overrides,
  };
}

const root = comment("1", glados, "**[HIGH]** pays the wrong output.", "2026-01-01T00:00:00Z");
const writeAccess = async () => ({ permission: "write" });

test("review memory reads threads after Phase A and keeps this run's agreements", async () => {
  // Resolved before Phase A; unresolved with a new objection by the time memory loads.
  const fresh = thread("PRRT_1", [
    root,
    comment("2", "alice", "This still pays the wrong output.", "2026-01-03T00:00:00Z"),
  ]);
  const agreedThread = thread("PRRT_2", [
    { ...root, id: "5" },
    comment("6", "alice", "Intentional.", "2026-01-02T00:00:00Z"),
    comment("7", glados, formatReplyBody("agree", "Agreed.", "6"), "2026-01-02T01:00:00Z"),
  ]);
  const agreed = listSettledFindings([agreedThread], glados);
  const memory = await loadReviewMemory(
    {
      threads: async () => ({ login: glados, threads: [fresh] }),
      issueComments: async () => [],
      lookup: writeAccess,
    },
    agreed,
    "alice",
  );
  assert.deepEqual(memory.settled.map((item) => item.threadId), ["PRRT_2"]);
  assert.match(memory.context, /still pays the wrong output/);
});

test("review memory falls back to this run's agreements when loading fails", async () => {
  const agreedThread = thread("PRRT_2", [
    root,
    comment("6", "alice", "Intentional.", "2026-01-02T00:00:00Z"),
    comment("7", glados, formatReplyBody("agree", "Agreed.", "6"), "2026-01-02T01:00:00Z"),
  ]);
  const agreed = listSettledFindings([agreedThread], glados);
  const memory = await loadReviewMemory(
    {
      threads: async () => {
        throw new Error("GraphQL down");
      },
      issueComments: async () => [],
      lookup: writeAccess,
    },
    agreed,
    "alice",
  );
  assert.deepEqual(memory.settled, agreed);
  assert.match(memory.context, /BEGIN_UNTRUSTED_SETTLED_FINDINGS/);
});
