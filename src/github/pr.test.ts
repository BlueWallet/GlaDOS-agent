import assert from "node:assert/strict";
import test from "node:test";
import { pullRequestRefFromNotification } from "./pr.js";

test("every PullRequest notification can wake thread processing", () => {
  assert.deepEqual(
    pullRequestRefFromNotification(
      "PullRequest",
      "https://api.github.com/repos/acme/widgets/pulls/42",
    ),
    {
      owner: "acme",
      repo: "widgets",
      prNumber: 42,
      prUrl: "https://github.com/acme/widgets/pull/42",
    },
  );
});

test("non-PR notifications do not wake thread processing", () => {
  assert.equal(
    pullRequestRefFromNotification(
      "Issue",
      "https://api.github.com/repos/acme/widgets/issues/42",
    ),
    null,
  );
});
