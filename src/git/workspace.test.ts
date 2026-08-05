import assert from "node:assert/strict";
import test from "node:test";
import { withPrLock } from "./workspace.js";

test("per-PR lock rejects an overlapping local run", async () => {
  const owner = `lock-test-${process.pid}-${Date.now()}`;
  let release!: () => void;
  let markEntered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });

  const first = withPrLock(owner, "repo", 1, () => {
    markEntered();
    return held;
  });
  await entered;
  try {
    await assert.rejects(
      withPrLock(owner, "repo", 1, async () => undefined),
      /already being processed/i,
    );
  } finally {
    release();
    await first;
  }
});
