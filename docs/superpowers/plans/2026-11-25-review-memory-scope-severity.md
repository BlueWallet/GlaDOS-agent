# Review memory, scope rule, and impact severity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GLaDOS remembers earlier rounds (trusted resolutions, owner decisions, earlier findings), judges PRs against their stated scope, and labels severity by impact.

**Architecture:** Pure selection/formatting in `thread-replies/logic.ts` and a new `thread-replies/memory.ts`; GitHub I/O in `github/` (`threads.ts`, new `comments.ts`, new `permissions.ts`); wiring in `thread-replies/process.ts`; prompt and merge changes in `review/payload.ts`.

**Tech Stack:** TypeScript ESM, Node ≥ 22.13, `node:test` via `tsx`, `@actions/github` Octokit.

Spec: `docs/superpowers/specs/2026-11-25-review-memory-scope-severity-design.md`

## Global Constraints

- ESM imports use `.js` extensions. Tests co-located as `*.test.ts`.
- `review/` keeps no thread-reply knowledge; memory lives in `thread-replies/`.
- Prompt data from GitHub users is untrusted: encode `<>&` and fence it.
- Bounds: owner comment 1,500 chars each, 12,000 total; earlier findings 8,000 total.
- Topic match: ≥ 2 shared identifiers and overlap ≥ 0.6 of the smaller set, same path.
- Trusted: PR author, or permission `admin`/`write`, or role `admin`/`maintain`/`write`; never GLaDOS, never bots; lookup errors → untrusted.
- Commands: `npm test`, `npm run typecheck` (Node 22: `export PATH=/home/box/node22/node-v22.21.1-linux-x64/bin:$PATH`).

---

### Task 1: Impact severity rubric, scope rule, no-escalation (prompts)

**Files:** Modify `src/review/payload.ts` (`buildReviewPrompt`, `buildVerifyPrompt`); Test `src/review/payload.test.ts`.

**Interfaces:** Produces exported `SEVERITY_RUBRIC: string[]` and `SCOPE_RULES: string[]` used by both prompts.

- [ ] Step 1: tests — draft prompt matches `/high: .*wrong money/i`, `/medium: .*without a test/i`, `/low: .*error messages/i`, `/wrong error message .* is low/i`, `/Do not raise the severity of a concern raised in an earlier round/i`, `/deliberately reuses an existing/i`, `/not as findings and not as follow-ups/i`; does not match `/high: .*test gaps/i` or `/depend on it/i`. Verify prompt includes the same rubric and scope lines, a drop rule `/out of scope/i`, and no longer says `/test gaps for changed behavior are valid high/i`. Replace the old `/high: .*test gaps/i` assertion.
- [ ] Step 2: `npm test` → FAIL on the new assertions.
- [ ] Step 3: implement:
```ts
export const SEVERITY_RUBRIC = [
  "Severity is about impact on users, not about how interesting the code is:",
  "- critical: security issues, loss of funds, data loss, broken core functionality.",
  "- high (blocking): wrong money or amount handling, wrong signature handling, data loss, or a crash or hang on a path users can actually hit.",
  "- medium: a real bug on an unlikely path, or changed behavior without a test.",
  "- low: error messages, wording, docs, style.",
  "Calibration: a wrong error message when a parser rejects input is low. Accepting a signature that does not commit to the outputs is high. A missing test for a new branch is medium. A crash reachable only with a hand-crafted input the app never produces is medium.",
  "Do not raise the severity of a concern raised in an earlier round unless the code there got worse.",
];
export const SCOPE_RULES = [
  "Scope:",
  "- Judge the change against its stated goal and spec: the PR title, description, and any spec or design docs this diff adds or changes.",
  "- When the PR deliberately reuses an existing code path, matching that path's current behavior is correct. Do not report the reused path's existing behavior.",
  "- Out-of-scope issues and pre-existing issues (in unchanged code, or in existing behavior the PR merely reuses) are dropped entirely: report them not as findings and not as follow-ups.",
];
```
Replace the draft "Severity:" block with `...SEVERITY_RUBRIC`, add `...SCOPE_RULES` after Requirements, change "Do not report pre-existing behavior unless this diff makes it worse or depends on it." to "…unless this diff makes it worse.". In verify: add both blocks, change drop rule to "it describes pre-existing behavior this diff did not worsen, or behavior of an existing path the PR deliberately reuses", add "- it is out of scope for the PR's stated goal", replace the "Architecture problems … valid high findings" sentence with "Judge severity by the rubric above."
- [ ] Step 4: `npm test` → PASS; `npm run typecheck` clean.
- [ ] Step 5: commit `review: impact-based severity rubric, scope rule, and no-escalation`.

### Task 2: Message-only lowering in verify

**Files:** Modify `src/review/payload.ts` (`VerifiedReviewFinding`, `VERIFY_JSON_SCHEMA`, `parseVerifiedReviewResult`, `mergeVerifiedFindings`, verify prompt); Test `src/review/payload.test.ts`.

**Interfaces:** `VerifiedReviewFinding.messageOnly?: boolean`.

- [ ] Step 1: tests — (a) high candidate kept as `{severity:"low", messageOnly:true}` without evidence merges to `low`; (b) `{severity:"medium", messageOnly:true}` without evidence stays `high`; (c) parser rejects non-boolean `messageOnly` and keeps `true`; (d) verify prompt matches `/"messageOnly": true/` and `/only impact is user-facing text/i`.
- [ ] Step 2: `npm test` → FAIL.
- [ ] Step 3: implement: in merge, `const messageOnlyLow = finding.messageOnly === true && severity === "low";` and keep draft severity only when `unblocked && !hasEvidence(finding.evidence) && !messageOnlyLow`. Parser: `finding.messageOnly !== undefined && typeof finding.messageOnly !== "boolean"` → throw; copy when true. Prompt line: "When a kept finding's only impact is user-facing text, wording, or docs, set \"messageOnly\": true and lower it to low; no evidence is needed for that."
- [ ] Step 4: PASS + typecheck. Step 5: commit `review: verify may lower message-only findings to low without blocker evidence`.

### Task 3: Settled by trusted resolution

**Files:** Modify `src/github/threads.ts` (queries + `ReviewThread.resolvedByLogin: string | null`), `src/thread-replies/logic.ts` (`SettledFinding.settledBy`, `listSettledFindings`, `formatSettledContext`); Test `src/thread-replies/logic.test.ts` (update `thread()` helper with `resolvedByLogin: null`).

**Interfaces:** `listSettledFindings(threads, gladosLogin, trusted: ReadonlySet<string> = new Set()): SettledFinding[]`; `SettledFinding.settledBy: "agreement" | "resolution"`; trusted logins compared lowercase.

- [ ] Step 1: tests — resolved by `alice` with `trusted = {"alice"}` → settled with `settledBy:"resolution"`, `agreementBody` = last non-GLaDOS reply ("Fixed in abc"), or "Resolved by @alice." when no reply; resolved by `mallory` (untrusted) → not settled; `isResolved:false` with resolvedBy set → not settled; root not by GLaDOS → not settled; agree-marker thread still `settledBy:"agreement"`; `formatSettledContext` mentions `/resolved by the PR author or a maintainer/i`.
- [ ] Step 2: FAIL. Step 3: implement (agreement wins; resolution branch: `thread.isResolved && thread.resolvedByLogin && trusted.has(lower)` and root by GLaDOS). GraphQL: add `resolvedBy { login }` to both thread queries and map in `materializeThread`.
- [ ] Step 4: PASS + typecheck. Step 5: commit `thread-replies: a thread resolved by the author or a maintainer is settled`.

### Task 4: Topic-based suppression

**Files:** Modify `src/thread-replies/logic.ts` (`suppressSettledFindings`, new exported `codeTopics`, `sameTopic`); Test `logic.test.ts`.

**Interfaces:** `codeTopics(text: string): Set<string>`; `sameTopic(a: string, b: string): boolean`.

- [ ] Step 1: tests — `codeTopics("`Psbt.read(scanned)` returns `Left`; inputSignatures runs after")` ⊇ {psbt, read, scanned, left, inputsignatures}; reworded repeat on same path sharing `Psbt.read`, `inputSignatures` → suppressed; same path but disjoint identifiers → kept; same identifiers on another path → kept; one shared identifier only → kept; existing exact-text test still passes (rename it to "…by path and issue text or topic").
- [ ] Step 2: FAIL. Step 3: implement:
```ts
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;
export function codeTopics(text: string): Set<string> {
  const topics = new Set<string>();
  const add = (s: string) => { for (const w of s.match(IDENT) ?? []) if (w.length >= 3) topics.add(w.toLowerCase()); };
  for (const span of text.matchAll(/`([^`]+)`/g)) add(span[1]!);
  for (const w of text.replace(/`[^`]*`/g, " ").match(/[A-Za-z_][\w.]*[\w]/g) ?? [])
    if (/[a-z][A-Z]|_|\./.test(w)) add(w);
  return topics;
}
export function sameTopic(a: string, b: string): boolean {
  const x = codeTopics(a), y = codeTopics(b);
  let shared = 0; for (const t of x) if (y.has(t)) shared++;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.6;
}
```
Filter keeps a finding unless some settled item has the same path and (exact normalized body or `sameTopic`).
- [ ] Step 4: PASS. Step 5: commit `thread-replies: suppress reworded repeats of settled findings by code topic`.

### Task 5: Owner decisions and earlier open findings (pure)

**Files:** Create `src/thread-replies/memory.ts`, `src/thread-replies/memory.test.ts`.

**Interfaces:**
```ts
export interface ConversationComment { id: string; authorLogin: string; authorIsBot: boolean; body: string; createdAt: string; path?: string }
export function isBotLogin(login: string): boolean // endsWith("[bot]")
export function selectOwnerDecisions(comments: ConversationComment[], trusted: ReadonlySet<string>, gladosLogin: string): ConversationComment[]
export function threadReplies(threads: ReviewThread[]): ConversationComment[] // non-root comments, path set
export function formatOwnerDecisions(comments: ConversationComment[]): string
export function formatEarlierFindings(threads: ReviewThread[], settled: SettledFinding[], gladosLogin: string): string
export function formatReviewMemory(parts: string[]): string // join non-empty
```
- [ ] Step 1: tests — untrusted, GLaDOS, bot (`[bot]` or `authorIsBot`) excluded; glados control markers stripped; each body truncated to 1,500 chars with "…"; total ≤ 12,000 keeping newest, output chronological; `<`/`>` encoded; header has the owner-decision rule `/do not reopen an owner decision unless you show new evidence of concrete harm/i`; empty input → "". Earlier findings: only GLaDOS roots not in settled, severity parsed from `**[HIGH]**`, total ≤ 8,000, header says they do not suppress and repeats keep their severity unless code got worse.
- [ ] Step 2: FAIL (module missing). Step 3: implement. Step 4: PASS. Step 5: commit `thread-replies: owner decisions and earlier findings as bounded review context`.

### Task 6: GitHub I/O, trust, wiring, docs

**Files:** Create `src/github/comments.ts`, `src/github/permissions.ts`, `src/github/permissions.test.ts`; Modify `src/thread-replies/process.ts`, `AGENTS.md`.

**Interfaces:**
```ts
// permissions.ts
export function isWriteAccess(data: { permission?: string; role_name?: string }): boolean
export async function loadTrustedLogins(githubToken, pr, author: string, logins: Iterable<string>, gladosLogin: string): Promise<Set<string>>
// comments.ts
export async function listIssueComments(githubToken, pr): Promise<ConversationComment[]>
export async function getPullRequestAuthor(githubToken, pr): Promise<string>
```
- [ ] Step 1: tests — `isWriteAccess` true for permission admin/write and role maintain/write/admin; false for read/triage/none/empty.
- [ ] Step 2: FAIL. Step 3: implement; `loadTrustedLogins` adds author (unless bot/GLaDOS), looks up each other distinct login (skip bots/GLaDOS) via `octokit.rest.repos.getCollaboratorPermissionLevel`, catch → untrusted with one log line. Wire `processPrReviewWithThreadReplies`: load author + issue comments, compute trusted set from resolvers + reply authors + comment authors, pass to `processReviewThreads` → `listSettledFindings(threads, login, trusted)`, build `extraContext = formatReviewMemory([formatSettledContext(settled), formatOwnerDecisions(selectOwnerDecisions([...issueComments, ...threadReplies(threads)], trusted, login)), formatEarlierFindings(threads, settled, login)])`. Log counts. Memory load failure must not fail the review: catch, log, fall back to agree-marker memory only.
- [ ] Step 4: PASS + typecheck. Update AGENTS.md (Severity, memory, scope). Step 5: commit `thread-replies: load trusted resolutions and owner decisions before review`.

## Self-review
Spec coverage: settled-by-resolution (T3, T6), trust (T6), topic suppression (T4), owner decisions + bounds (T5, T6), scope (T1), rubric + examples + no-escalation (T1), message-only lowering (T2), earlier findings for no-escalation (T5). No placeholders; names consistent (`listSettledFindings`, `selectOwnerDecisions`, `loadTrustedLogins`).
