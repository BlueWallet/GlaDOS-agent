import assert from "node:assert/strict";
import test from "node:test";
import { isWriteAccess, loadTrustedLogins } from "./permissions.js";

test("write access means admin or write permission, or a write-level role", () => {
  for (const data of [
    { permission: "admin" },
    { permission: "write" },
    { permission: "read", role_name: "maintain" },
    { permission: "read", role_name: "write" },
    { role_name: "admin" },
  ]) {
    assert.equal(isWriteAccess(data), true, JSON.stringify(data));
  }
  for (const data of [
    { permission: "read" },
    { permission: "read", role_name: "triage" },
    { permission: "none" },
    {},
  ]) {
    assert.equal(isWriteAccess(data), false, JSON.stringify(data));
  }
});

test("trusted logins are the PR author plus write users, never GLaDOS, bots, or failed lookups", async () => {
  const asked: string[] = [];
  const trusted = await loadTrustedLogins(
    async (login) => {
      asked.push(login);
      if (login === "broken") throw new Error("403");
      return { permission: login === "maint" ? "write" : "read" };
    },
    "Author",
    ["Maint", "maint", "reader", "broken", "GLaDOS", "coderabbitai[bot]", "author", ""],
    "glados",
  );
  assert.deepEqual([...trusted].sort(), ["author", "maint"]);
  assert.deepEqual(asked.sort(), ["broken", "maint", "reader"]);
});

test("a bot or GLaDOS author is not trusted", async () => {
  const trusted = await loadTrustedLogins(async () => ({ permission: "admin" }), "dependabot[bot]", [], "glados");
  assert.deepEqual([...trusted], []);
  const self = await loadTrustedLogins(async () => ({ permission: "admin" }), "GLaDOS", [], "glados");
  assert.deepEqual([...self], []);
});
