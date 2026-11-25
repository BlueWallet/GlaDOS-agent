# cursor-glados — agent guide

GLaDOS reviews open PRs with a pending review request for the authenticated user, and replies when humans respond on its review-comment threads.

1. **Full review:** GitHub Search finds `review-requested:@me` PRs → clone → Cursor SDK local agent → post summary + inline comments (`APPROVE` or `REQUEST_CHANGES`).
2. **Thread replies (optional feature):** On every PR notification wake-up (and before each full review) → inspect GLaDOS review threads → agree (reply + resolve) or disagree (reply, leave open). Settled findings (GLaDOS agreed, or the PR author / a write-access user resolved the thread) are never re-raised on later reviews of that PR.

TypeScript, ESM (`"type": "module"`), Node ≥ 22.13. Run scripts with `tsx`.

## Commands

```bash
export GLADOS_TOKEN='ghp_...'      # GitHub PAT: search + notifications + repo + pull_requests
export CURSOR_API_KEY='cursor_...'

npm run notifications              # review-requested PRs + PR notification wake-ups; clear inbox
npm run notifications -- --all     # include read notifications when listing inbox
npm run smoke                      # local Cursor SDK smoke test (cwd = this repo; draft model)
npm test                           # unit tests (node:test via tsx)
npm run typecheck                  # TypeScript check (CI "lint")
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `typecheck`, and `test` on PRs and pushes to `master`.

`@connectrpc/connect-node` is required at runtime by `@cursor/sdk` but is not bundled — keep it in `package.json`.

## Layout

Only `src/cli/` contains runnable entrypoints. Everything else is library code.

```
src/
  cli/
    notifications.ts    # entrypoint: wires features; inbox cleanup
    smoke.ts            # entrypoint: one-shot local Agent.prompt smoke test

  types.ts              # NotificationThread, PullRequestRef

  git/
    workspace.ts        # clone to /tmp/glados-*/repository, PR lock, withPrWorkspace()

  github/
    notifications.ts    # listNotifications(), markNotificationDone()
    pr.ts               # search review-requested PRs, pending-reviewer check, notification → PR ref
    diff.ts             # getCommentableLines() — RIGHT-side lines that accept comments
    comments.ts         # listIssueComments()
    permissions.ts      # isWriteAccess(), loadTrustedLogins() — who counts as the owner
    reviews.ts          # postGithubReview() — validate vs diff, then createReview
    threads.ts          # GraphQL: list/get review threads, reply, resolve (thread-replies I/O)

  review/               # core PR review feature — no thread-reply knowledge
    process.ts          # processPrReview() — orchestration only
    agent.ts            # runAgentReview() / promptLocalAgent() — Cursor SDK + sandbox/env
    payload.ts          # draft + verify prompts, parse, merge, GitHub formatting

  thread-replies/       # optional feature — delete this folder to rip out
    index.ts            # public API only (import from here outside the folder)
    process.ts          # Phase A + compose with full review
    agent.ts            # runThreadReplies()
    logic.ts            # classification, markers, settled findings, topic suppress, Phase A prompt/parse
    memory.ts           # owner decisions: selection, bounds; review-memory context
```

Co-located `*.test.ts` files use Node’s built-in test runner (`npm test`).

### Feature isolation / rip-out

| Feature | Folder | CLI wiring |
|---------|--------|------------|
| Core PR review | `src/review/` | `processPrReview` |
| Thread replies | `src/thread-replies/` | `processPrReviewWithThreadReplies`, `processPrThreadReplies` |

Today the CLI imports only from `thread-replies/` for reviews (that composer calls core review pieces). To disable thread replies:

1. In `cli/notifications.ts`, call `processPrReview` instead of `processPrReviewWithThreadReplies`, and remove the PR-notification → `processPrThreadReplies` branch (mark those notifications done like others).
2. Delete `src/thread-replies/`.
3. Delete `src/github/threads.ts` if unused.
4. Trim this guide’s Phase A sections.

New optional features get their own top-level folder under `src/` with an `index.ts` public surface; CLI wires them. Do not push feature logic into `review/`.

## Flow

```
cli/notifications.ts
  → parallel:
       github/pr.listReviewRequestedPullRequests()   # is:open is:pr review-requested:@me
       github/notifications.listNotifications()
  → per review-requested PR:
       thread-replies.processPrReviewWithThreadReplies()
         → withPrLock + withPrWorkspace
         → Phase A (processReviewThreads)
         → review memory: PR author, issue comments, permission lookups → trusted logins
         → review/agent.runAgentReview(+ settled context, owner decisions)
         → suppressSettledFindings + sanitize markers
         → payload.buildGithubReview → reviews.postGithubReview
  → per PullRequest notification (wake-up only; GitHub coalesces PR activity):
       thread-replies.processPrThreadReplies()       # Phase A only; clone only if a reply is needed
       markNotificationDone() only if Phase A complete
  → other notifications: markNotificationDone()
```

**Review queue:** Search drives which PRs get a full review. Notifications do **not** choose the review queue; every `PullRequest` notification is a Phase A wake-up to re-inspect thread state (do not rely on `latest_comment_url`).

**Duplicate protection:** before cloning for a full review, `isReviewRequestedForUser()` checks pending reviewers. After you submit a review you drop off that list until re-requested.

**Per-PR lock:** `withPrLock()` serializes overlapping local CLI runs so two processes cannot reply/review the same PR at once.

## Phase A — thread replies (`src/thread-replies/`)

**Awaiting:** root comment by GLaDOS, unresolved, not settled, and there is an unacknowledged human reply (anyone) after GLaDOS’s last acknowledgment.

**Agent:** `runThreadReplies()` with thread history + local checkout (draft model: `grok-4.7` low, non-fast / `GLADOS_REVIEW_MODEL`) → JSON `{ replies: [{ threadId, decision: "agree"|"disagree", body }] }` — exactly one decision per awaiting thread.

**Actions:**
- Agree → controlled reply (`<!-- glados:reply-to:… -->` + `<!-- glados:agree -->`) → `resolveReviewThread` when `viewerCanResolve`.
- Disagree → controlled reply with acknowledgment marker only; leave open. Back-and-forth continues indefinitely whenever someone replies after GLaDOS.
- Agreed but unresolved → retry resolve only (no new agent reply). If `viewerCanResolve` is false, leave Phase A incomplete so the notification is retained for later retry; still treat the issue as settled for the following full review.

**Race safety:** re-fetch the target thread immediately before each write; compare full comment id/body/`updatedAt` snapshots. After posting, reconcile — if a human raced in, the thread stays awaiting.

**Markers:** appended only by `formatReplyBody()` / controlled code in `thread-replies/logic.ts`. Stripped before posting reviews via `sanitizeReviewForPost()`. Root findings never count as agreements.

## Full review (`src/review/`)

Two agent passes, then optional settled-finding suppression:

1. **Draft** (`buildReviewPrompt`, `grok-4.7` xhigh non-fast / `GLADOS_REVIEW_MODEL`) — dry technical findings. The prompt is a port of the superpowers `code-reviewer` template: checklist over plan alignment, code quality, architecture, testing, and production readiness, and every critical/high issue must be reported. If `findings` is empty, skip verify and run a GLaDOS voice rewrite of the summary (`buildVoicePrompt`) on the verify model.
2. **Verify** (`buildVerifyPrompt`, `grok-4.7` xhigh non-fast, fresh context) — re-read callees, drop disproven candidates, rewrite kept text in GLaDOS voice. Candidate IDs let `mergeVerifiedFindings()` restore the original anchors and cap severity; unknown or duplicate IDs fail the review. Dropped candidates are returned in `dropped` with evidence; a `critical`/`high` candidate dropped without evidence is restored with its draft severity and body (`undisprovenBlockers()`), and one lowered below `high` without `evidence` keeps its draft severity. Blocker evidence must cite a file (e.g. `src/storage.ts`); it is not checked for truth — the dropped-candidate log lines are the audit trail. Unknown, duplicate, or kept-and-dropped ids in `dropped` fail the review. `GLADOS_VERIFY_MODEL` overrides the verify pass. Voice uses this model too.

**Severity** (`SEVERITY_RUBRIC`, impact based, shared by draft and verify): `critical` = security, loss of funds, data loss, broken core functionality. `high` (blocking) = wrong money/amount or signature handling, data loss, or a crash/hang on a path users can actually hit. `medium` = a real bug on an unlikely path, or changed behavior without a test. `low` = error messages, wording, docs, style. Calibration examples live in the rubric. No escalation: a concern from an earlier round keeps its severity unless the code there got worse.

**Scope** (`SCOPE_RULES`, draft only): the PR is judged against its stated goal/spec (title, body, spec docs in the diff). Matching the current behavior of an existing path the PR deliberately reuses is correct. Out-of-scope and pre-existing issues are dropped entirely — not findings, not follow-ups. Verify does not get these rules: it may drop or demote a blocker only with code disproof.

**Review memory** (composed with thread replies, `thread-replies/memory.ts`): before each full review GLaDOS loads the PR author, conversation comments, and permissions (`getCollaboratorPermissionLevel`; `admin`/`write` permission or `admin`/`maintain`/`write` role; GLaDOS and bots never count, including a `Bot` resolver by `__typename`; failed lookups are untrusted). It injects as `extraContext` into both `buildReviewPrompt()` and `buildVerifyPrompt()`:
- settled findings (original body + why: GLaDOS agreement, or the resolver's latest reply on a thread resolved by a trusted user — other trusted replies there stay owner decisions; 600 chars per text, 16,000 total, oldest first, newest kept; encoded JSON inside `BEGIN/END_UNTRUSTED_SETTLED_FINDINGS`);
- owner decisions: conversation comments and replies on unsettled threads by trusted humans, newest kept, 1,500 chars each, 12,000 total, encoded JSON inside `BEGIN/END_UNTRUSTED_OWNER_DECISIONS` — do not re-raise what the owner declined or deferred, do not reopen a decision without new evidence of concrete harm.

Settled repeats are suppressed on the draft only (verify cannot add findings): same path and exact text, or the same code topic — the finding names ≥ 2 identifiers (fenced blocks and ubiquitous tokens like `null`/`error` ignored), all already in the settled text, covering ≥ half of it. An emptied draft gets an explicit "repeated a settled issue" summary. Open/disagreed threads do **not** suppress new findings. If memory cannot load, the review falls back to agreements only.

**Approve vs request changes:** `critical` or `high` → `REQUEST_CHANGES`; else `APPROVE`.

**Inline comments:** `path` + `line` → RIGHT-side review comments. Anchors outside the PR diff are demoted into the body (`getCommentableLines` / `appendCommentsToBody`); one bad anchor would 422 the whole batch.

**Agent must not run tests, builds, package managers, installers, or repository scripts** — review by reading files only (CI runs tests). Same rule for Phase A.

## Agent isolation (local Cursor SDK)

| Measure | Why |
|---------|-----|
| Checkout always under `…/repository` | Repo name must not become workspace policy (e.g. a repo named `.cursor`) |
| Agent `cwd` = temp parent of checkout | Repo `.cursor/sandbox.json` is review data, not active policy |
| Disposable `HOME` / XDG / `TMP*` under the temp workspace | No host `~/.ssh` or ambient `~/.cursor` |
| Environment allowlist | No ambient tokens/DSNs for agent child processes |
| `sandboxOptions: { enabled: false }` | Actions runners fail sandbox preflight; keep off |
| `settingSources: []` | No ambient Cursor settings layers |
| Git auth: `http.https://github.com/.extraHeader` + `GIT_LFS_SKIP_SMUDGE=1` | Scope PAT to GitHub; avoid LFS smudge/token leak |
| Auth not persisted in `.git/config` | Agent must not read the PAT from the clone |

`CURSOR_API_KEY` is passed explicitly to `Agent.prompt`; it is not left in the sanitized env.

## Key extension points

| What | Where |
|------|--------|
| Reviewer instructions / JSON schema | `review/payload.ts` → `buildReviewPrompt()` / `buildVerifyPrompt()` / `buildVoicePrompt()` |
| Severity levels | `review/payload.ts` → `SEVERITIES` + `Severity` |
| GLaDOS voice | `review/payload.ts` → `buildVerifyPrompt()`; `applyPersonality()` still wraps at post time |
| Thread reply prompt / classification / suppress | `thread-replies/logic.ts` |
| Owner decisions / memory bounds | `thread-replies/memory.ts` |
| Severity rubric / scope rule | `review/payload.ts` → `SEVERITY_RUBRIC` / `SCOPE_RULES` |
| Phase A + compose with review | `thread-replies/process.ts` |
| Core review wiring | `review/process.ts` (no business logic) |
| Clone / lock / cleanup | `git/workspace.ts` |
| GitHub I/O | `github/` |

Tune **draft prompt**, **verify prompt**, **voice prompt**, **thread-reply prompt**, and **personality** independently.

Design detail: `docs/superpowers/specs/2026-08-05-review-thread-replies-design.md`.

## Conventions

- **ESM imports** use `.js` extensions in TypeScript source.
- **New runnable scripts** go in `src/cli/` only; wire in `package.json`.
- **New library code** goes in a domain folder (`github/`, `git/`, `review/`) or a feature folder (`thread-replies/`, …) — not a generic `utils/`.
- **Feature folders** expose a small `index.ts` public API; outside code imports only from that.
- **Keep modules small:** `agent.ts` = SDK + isolation; `payload.ts` / `logic.ts` = pure data; `process.ts` = wiring.
- **Tests** live next to the code they cover (`*.test.ts`); add cases when changing classification, markers, locks, or suppression.
- **Minimize scope** — match existing style, no over-abstraction.

## Environment

| Variable | Used for |
|----------|----------|
| `GLADOS_TOKEN` | GitHub API (search, notifications, clone auth, reviews, thread reply/resolve) |
| `CURSOR_API_KEY` | Cursor SDK local agent runs |
| `GLADOS_REVIEW_MODEL` | Optional draft-pass model (default `grok-4.7` with `reasoning_effort=xhigh`, `fast=false`) |
| `GLADOS_VERIFY_MODEL` | Optional verify and voice model (default `grok-4.7` with `reasoning_effort=xhigh`, `fast=false`) |

`GLADOS_TOKEN` needs access to arbitrary repos that send review requests (`repo` scope or equivalent). Resolving conversations additionally requires being the PR author **or** having write access on the repo — when that fails, agreement still settles for the following full review but Phase A stays incomplete for retry. Review memory reads collaborator permissions; if GitHub refuses that lookup, those users count as untrusted (the PR author is always trusted).
