# cursor-glados — agent guide

GLaDOS reviews open PRs with a pending review request for the authenticated user, and replies when humans respond on its review-comment threads.

1. **Full review (Phase B):** GitHub Search finds `review-requested:@me` PRs → clone → Cursor SDK local agent → post summary + inline comments (`APPROVE` or `REQUEST_CHANGES`).
2. **Thread replies (Phase A):** On every PR notification wake-up (and before each full review) → inspect GLaDOS review threads → agree (reply + resolve) or disagree (reply, leave open). Settled agreements are never re-raised on later reviews of that PR.

TypeScript, ESM (`"type": "module"`), Node ≥ 22.13. Run scripts with `tsx`.

## Commands

```bash
export GLADOS_TOKEN='ghp_...'      # GitHub PAT: search + notifications + repo + pull_requests
export CURSOR_API_KEY='cursor_...'

npm run notifications              # Phase A + Phase B for pending reviews; Phase A for PR notifications; clear inbox
npm run notifications -- --all     # include read notifications when listing inbox
npm run smoke                      # local Cursor SDK smoke test (cwd = this repo)
npm test                           # unit tests (node:test via tsx)
npm run typecheck
```

`@connectrpc/connect-node` is required at runtime by `@cursor/sdk` but is not bundled — keep it in `package.json`.

## Layout

Only `src/cli/` contains runnable entrypoints. Everything else is library code.

```
src/
  cli/
    notifications.ts    # entrypoint: review-requested PRs, then PR notification wake-ups, inbox cleanup
    smoke.ts            # entrypoint: one-shot local Agent.prompt smoke test

  types.ts              # NotificationThread, PullRequestRef

  git/
    workspace.ts        # clone to /tmp/glados-*/repository, PR lock, withPrWorkspace()

  github/
    notifications.ts    # listNotifications(), markNotificationDone()
    pr.ts               # search review-requested PRs, pending-reviewer check, notification → PR ref
    diff.ts             # getCommentableLines() — RIGHT-side lines that accept comments
    reviews.ts          # postGithubReview() — validate vs diff, then createReview
    threads.ts          # GraphQL: list/get review threads, reply, resolve

  review/
    process.ts          # processPrReview() — Phase A then Phase B wiring only
    thread-process.ts   # processPrThreadReplies() / processReviewThreads() — Phase A orchestration
    agent.ts            # runAgentReview() / runThreadReplies() — Cursor SDK + sandbox/env isolation
    payload.ts          # review prompt, parse, GitHub formatting, personality, strip control markers
    threads.ts          # pure: awaiting/settled classification, Phase A prompt/parse, suppress settled findings
```

Co-located `*.test.ts` files use Node’s built-in test runner (`npm test`).

## Flow

```
cli/notifications.ts
  → parallel:
       github/pr.listReviewRequestedPullRequests()   # is:open is:pr review-requested:@me
       github/notifications.listNotifications()
  → per review-requested PR:
       review/process.processPrReview()
         → withPrLock
         → isReviewRequestedForUser()                # skip if not on pending list
         → withPrWorkspace → /tmp/glados-*/repository
         → thread-process.processReviewThreads()     # Phase A
         → agent.runAgentReview(+ settled context)   # Phase B
         → suppressSettledFindings()
         → payload.buildGithubReview() → reviews.postGithubReview()
  → per PullRequest notification (wake-up only; GitHub coalesces PR activity):
       thread-process.processPrThreadReplies()       # Phase A only; clone only if a reply is needed
       markNotificationDone() only if Phase A complete
  → other notifications: markNotificationDone()
```

**Review queue:** Search drives which PRs get a full review. Notifications do **not** choose the review queue; every `PullRequest` notification is a Phase A wake-up to re-inspect thread state (do not rely on `latest_comment_url`).

**Duplicate protection:** before cloning for a full review, `isReviewRequestedForUser()` checks pending reviewers. After you submit a review you drop off that list until re-requested.

**Per-PR lock:** `withPrLock()` serializes overlapping local CLI runs so two processes cannot reply/review the same PR at once.

## Phase A — thread replies

**Awaiting:** root comment by GLaDOS, unresolved, not settled, and there is an unacknowledged human reply (anyone) after GLaDOS’s last acknowledgment.

**Agent:** `runThreadReplies()` with thread history + local checkout → JSON `{ replies: [{ threadId, decision: "agree"|"disagree", body }] }` — exactly one decision per awaiting thread.

**Actions:**
- Agree → controlled reply (`<!-- glados:reply-to:… -->` + `<!-- glados:agree -->`) → `resolveReviewThread` when `viewerCanResolve`.
- Disagree → controlled reply with acknowledgment marker only; leave open. Back-and-forth continues indefinitely whenever someone replies after GLaDOS.
- Agreed but unresolved → retry resolve only (no new agent reply). If `viewerCanResolve` is false, leave Phase A incomplete so the notification is retained for later retry; still treat the issue as settled for Phase B.

**Race safety:** re-fetch the target thread immediately before each write; compare full comment id/body/`updatedAt` snapshots. After posting, reconcile — if a human raced in, the thread stays awaiting.

**Markers:** appended only by `formatReplyBody()` / controlled code. Strip from all model-authored review text via `stripGladosControlMarkers()`. Root findings never count as agreements.

## Phase B — full review

Inject settled findings (original body + agreement reason) into `buildReviewPrompt()`. After parse, `suppressSettledFindings()` removes exact text repeats and regenerates the summary if anything was dropped. Open/disagreed threads do **not** suppress new findings.

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
| `sandboxOptions: { enabled: true }` | Constrain tool execution |
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
| Thread reply prompt / classification / suppress | `review/threads.ts` |
| Phase A orchestration | `review/thread-process.ts` |
| Phase B wiring | `review/process.ts` (no business logic) |
| Clone / lock / cleanup | `git/workspace.ts` |
| GitHub I/O | `github/` |

Tune **review prompt**, **thread-reply prompt**, and **personality** independently.

Design detail: `docs/superpowers/specs/2026-08-05-review-thread-replies-design.md`.

## Conventions

- **ESM imports** use `.js` extensions in TypeScript source.
- **New runnable scripts** go in `src/cli/` only; wire in `package.json`.
- **New library code** goes in `github/`, `git/`, or `review/` — not a generic `utils/`.
- **Keep modules small:** `agent.ts` = SDK + isolation; `payload.ts` / `threads.ts` = pure data; `process.ts` / `thread-process.ts` = wiring.
- **Tests** live next to the code they cover (`*.test.ts`); add cases when changing classification, markers, locks, or suppression.
- **Minimize scope** — match existing style, no over-abstraction.

## Environment

| Variable | Used for |
|----------|----------|
| `GLADOS_TOKEN` | GitHub API (search, notifications, clone auth, reviews, thread reply/resolve) |
| `CURSOR_API_KEY` | Cursor SDK local agent runs |

`GLADOS_TOKEN` needs access to arbitrary repos that send review requests (`repo` scope or equivalent). Resolving conversations additionally requires being the PR author **or** having write access on the repo — when that fails, agreement still settles for Phase B but Phase A stays incomplete for retry.
