# cursor-glados — agent guide

GLaDOS reviews open PRs with a pending review request for the authenticated user, and replies when humans respond on its review-comment threads.

1. **Full review:** GitHub Search finds `review-requested:@me` PRs → clone → Cursor SDK local agent → post summary + inline comments (`APPROVE` or `REQUEST_CHANGES`).
2. **Thread replies (optional feature):** On every PR notification wake-up (and before each full review) → inspect GLaDOS review threads → agree (reply + resolve) or disagree (reply, leave open). Settled agreements are never re-raised on later reviews of that PR.

TypeScript, ESM (`"type": "module"`), Node ≥ 22.13. Run scripts with `tsx`.

## Commands

```bash
export GLADOS_TOKEN='ghp_...'      # GitHub PAT: search + notifications + repo + pull_requests
export CURSOR_API_KEY='cursor_...'

npm run notifications              # review-requested PRs + PR notification wake-ups; clear inbox
npm run notifications -- --all     # include read notifications when listing inbox
npm run smoke                      # local Cursor SDK smoke test (cwd = this repo)
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
    reviews.ts          # postGithubReview() — validate vs diff, then createReview
    threads.ts          # GraphQL: list/get review threads, reply, resolve (thread-replies I/O)

  review/               # core PR review feature — no thread-reply knowledge
    process.ts          # processPrReview() — orchestration only
    agent.ts            # runAgentReview() / promptLocalAgent() — Cursor SDK + sandbox/env
    payload.ts          # review prompt, parse, GitHub formatting, personality

  thread-replies/       # optional feature — delete this folder to rip out
    index.ts            # public API only (import from here outside the folder)
    process.ts          # Phase A + compose with full review
    agent.ts            # runThreadReplies()
    logic.ts            # classification, markers, suppress, Phase A prompt/parse
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
         → review/agent.runAgentReview(+ settled context)
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

**Agent:** `runThreadReplies()` with thread history + local checkout → JSON `{ replies: [{ threadId, decision: "agree"|"disagree", body }] }` — exactly one decision per awaiting thread.

**Actions:**
- Agree → controlled reply (`<!-- glados:reply-to:… -->` + `<!-- glados:agree -->`) → `resolveReviewThread` when `viewerCanResolve`.
- Disagree → controlled reply with acknowledgment marker only; leave open. Back-and-forth continues indefinitely whenever someone replies after GLaDOS.
- Agreed but unresolved → retry resolve only (no new agent reply). If `viewerCanResolve` is false, leave Phase A incomplete so the notification is retained for later retry; still treat the issue as settled for the following full review.

**Race safety:** re-fetch the target thread immediately before each write; compare full comment id/body/`updatedAt` snapshots. After posting, reconcile — if a human raced in, the thread stays awaiting.

**Markers:** appended only by `formatReplyBody()` / controlled code in `thread-replies/logic.ts`. Stripped before posting reviews via `sanitizeReviewForPost()`. Root findings never count as agreements.

## Full review (`src/review/`)

When composed with thread replies, settled findings (original body + agreement reason) are injected as `extraContext` into `buildReviewPrompt()`. After parse, `suppressSettledFindings()` removes exact text repeats. Open/disagreed threads do **not** suppress new findings.

**Approve vs request changes:** `critical` or `high` → `REQUEST_CHANGES`; else `APPROVE`.

**Inline comments:** `path` + `line` → RIGHT-side review comments. Anchors outside the PR diff are demoted into the body (`getCommentableLines` / `appendCommentsToBody`); one bad anchor would 422 the whole batch.

**Agent must not run tests/builds/installers** — review by reading files only (CI runs tests). Same rule for Phase A.

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
| Reviewer instructions / JSON schema | `review/payload.ts` → `buildReviewPrompt()` |
| Severity levels | `review/payload.ts` → `SEVERITIES` + `Severity` |
| GLaDOS voice | `review/payload.ts` → `applyPersonality()` (post-time rewrite) |
| Thread reply prompt / classification / suppress | `thread-replies/logic.ts` |
| Phase A + compose with review | `thread-replies/process.ts` |
| Core review wiring | `review/process.ts` (no business logic) |
| Clone / lock / cleanup | `git/workspace.ts` |
| GitHub I/O | `github/` |

Tune **review prompt**, **thread-reply prompt**, and **personality** independently.

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

`GLADOS_TOKEN` needs access to arbitrary repos that send review requests (`repo` scope or equivalent). Resolving conversations additionally requires being the PR author **or** having write access on the repo — when that fails, agreement still settles for the following full review but Phase A stays incomplete for retry.
