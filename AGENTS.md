# cursor-glados — agent guide

GLaDOS reviews open PRs with a pending review request for the authenticated user, replies when humans respond on its review-comment threads, and answers `@mention`s in other threads and in the PR conversation.

1. **Full review:** GitHub Search finds `review-requested:@me` PRs → clone → fetch PR context (title, body, base, linked issues, reviews, conversation, threads) → Cursor SDK local agent → post summary + inline comments (`APPROVE` or `REQUEST_CHANGES`).
2. **Replies (optional feature):** On every PR notification wake-up (and before each full review) → own threads: agree (reply + resolve) or disagree (reply, leave open); foreign threads and conversation comments that mention GLaDOS: plain reply. Settled agreements are never re-raised on later reviews of that PR.

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
    threads.ts          # GraphQL: list/get review threads (core context), reply, resolve (feature)
    comments.ts         # GraphQL: list PR conversation + state (core context); createPrIssueComment (feature)
    pr-context.ts       # fetchPrContext() — PR core, linked issues, reviews, comments, threads

  review/               # core PR review feature — no thread-reply knowledge
    process.ts          # processPrReview(), loadPrContextBlock() — orchestration only
    agent.ts            # runAgentReview() / promptLocalAgent() — Cursor SDK + sandbox/env
    payload.ts          # draft + verify prompts, parse, merge, GitHub formatting
    context.ts          # formatPrContext() — tiered budget, HTML-comment strip, untrusted escaping

  thread-replies/       # optional feature — delete this folder to rip out
    index.ts            # public API only (import from here outside the folder)
    process.ts          # Phase A (threads + mentions) + compose with full review
    agent.ts            # runThreadReplies(), runMentionReply()
    logic.ts            # thread classification (own/foreign), markers, suppress, thread prompt/parse
    mentions.ts         # conversation mentions: awaiting, snapshot, prompt/parse, reply body
```

Co-located `*.test.ts` files use Node’s built-in test runner (`npm test`).

### Feature isolation / rip-out

| Feature | Folder | CLI wiring |
|---------|--------|------------|
| Core PR review | `src/review/` + `src/github/pr-context.ts` | `processPrReview` |
| Replies (threads + mentions) | `src/thread-replies/` | `processPrReviewWithThreadReplies`, `processPrThreadReplies` |

Today the CLI imports only from `thread-replies/` for reviews (that composer calls core review pieces). To disable replies:

1. In `cli/notifications.ts`, call `processPrReview` instead of `processPrReviewWithThreadReplies`, and remove the PR-notification → `processPrThreadReplies` branch (mark those notifications done like others).
2. Delete `src/thread-replies/`.
3. Keep `src/github/threads.ts` and `src/github/comments.ts` — their list functions feed the PR context. The mutations (`replyToReviewThread`, `resolveReviewThread`, `createPrIssueComment`) may be deleted.
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
         → Phase A (processReviewThreads: own + foreign threads, then mentions)
         → review/process.loadPrContextBlock()        # after replies, so they are included
         → review/agent.runAgentReview(+ prContext + settled context)
         → suppressSettledFindings + sanitize markers
         → payload.buildGithubReview → reviews.postGithubReview
  → per PullRequest notification (wake-up only; GitHub coalesces PR activity):
       thread-replies.processPrThreadReplies()       # Phase A only; clone only if a thread or mention awaits
       markNotificationDone() only if Phase A complete
  → other notifications: markNotificationDone()
```

**Review queue:** Search drives which PRs get a full review. Notifications do **not** choose the review queue; every `PullRequest` notification is a Phase A wake-up to re-inspect thread state (do not rely on `latest_comment_url`).

**Duplicate protection:** before cloning for a full review, `isReviewRequestedForUser()` checks pending reviewers. After you submit a review you drop off that list until re-requested.

**Per-PR lock:** `withPrLock()` serializes overlapping local CLI runs so two processes cannot reply/review the same PR at once.

## Phase A — replies (`src/thread-replies/`)

**Thread kind** (`threadReplyKind`): `own` when the root comment is GLaDOS’s, else `foreign`.

**Awaiting own thread** (`isAwaitingThread`): unresolved, not settled, and an unacknowledged human reply (anyone) after GLaDOS’s last acknowledgment.

**Awaiting foreign thread** (`isAwaitingForeignThread`): unresolved and either GLaDOS has not replied yet and a human comment mentions `@<login>`, or GLaDOS already replied (controlled marker) and a human commented after the acknowledged id.

**Awaiting mention** (`listAwaitingMentions`, `mentions.ts`): PR conversation comment by someone else, not minimized, mentions `@<login>`, and its id is not in any GLaDOS reply-to marker. Only explicit mentions count in the flat conversation.

**Bots and closed PRs:** bot authors never trigger foreign-thread or conversation replies; in an engaged foreign thread a bot comment counts only if it mentions GLaDOS (no bot-to-bot loops). Foreign-thread and conversation replies are skipped when the PR is not `OPEN` (state re-checked right before the write); own threads are always answered.

`mentionsLogin()` matches the whole handle (`[A-Za-z0-9-]` boundary, case-insensitive) outside fenced blocks, inline code, and quoted lines.

**Agents:**
- `runThreadReplies()` — thread history (with `kind`) + local checkout → JSON `{ replies: [{ threadId, decision: "agree"|"disagree"|"reply", body }] }`, exactly one per awaiting thread; `reply` is required for foreign threads and rejected for own ones.
- `runMentionReply()` — PR context block + up to `MENTION_BATCH` (10) oldest awaiting comments (bodies capped at 4k after escaping) → JSON `{ body }`, one consolidated reply; the rest wait for the next wake-up.

**Actions:**
- Agree → controlled reply (`<!-- glados:reply-to:… -->` + `<!-- glados:agree -->`) → `resolveReviewThread` when `viewerCanResolve`.
- Disagree → controlled reply with acknowledgment marker only; leave open. Back-and-forth continues indefinitely whenever someone replies after GLaDOS.
- Foreign reply → acknowledgment marker only; never agree, never resolve. The kind is derived from the thread, not from the agent output.
- Mention reply → one issue comment with one reply-to marker per answered comment id.
- Agreed but unresolved → retry resolve only (no new agent reply). If `viewerCanResolve` is false, leave Phase A incomplete so the notification is retained for later retry; still treat the issue as settled for the following full review.

**Race safety:** re-fetch the target thread (or the whole conversation) immediately before each write; compare full comment id/body/`updatedAt` (and `isMinimized`) snapshots. The conversation snapshot is taken right before the mention agent runs; a race skips the post and leaves Phase A incomplete without failing the full review. After posting, reconcile — if a human raced in, the thread or mention stays awaiting.

**Markers:** appended only by `formatReplyBody()` / `formatMentionReplyBody()` in `thread-replies/`; agent text is stripped of markers until stable so nested fragments cannot reassemble one. Stripped before posting reviews via `sanitizeReviewForPost()`. Root findings never count as agreements; an agree marker on a human-rooted thread never settles it.

## Full review (`src/review/`)

**PR context block** (`loadPrContextBlock` → `github/pr-context.fetchPrContext` + `review/context.formatPrContext`): title, description, base branch, head sha, author, linked issues (`closingIssuesReferences`), every review (own reviews labelled `(you, GLaDOS)`; `PENDING` and empty `COMMENTED` dropped), the conversation (minimized skipped), and every review thread (path:line, resolved/outdated, all comments). All HTML comments are stripped (hides PR-template boilerplate and control markers without feature knowledge); bodies are `<>&`-escaped with `BEGIN_/END_UNTRUSTED` fence tokens broken, then capped after escaping (4k; 12k for the description; linked issues shrink so header + issues fit in half the budget). Budget 50k chars by tier: header + issues (never omitted) → own open threads → own reviews → others’ reviews → others’ open threads → conversation → resolved threads; newest first within a tier; `[N older items omitted]` per section. Both prompts fence it as `BEGIN_UNTRUSTED_PR_CONTEXT … END_UNTRUSTED_PR_CONTEXT` and tell the agent to diff against the named base branch, that discussion is claims not proof, and not to repeat verbatim a finding already in an own open thread.

Two agent passes, then optional settled-finding suppression:

1. **Draft** (`buildReviewPrompt`, `grok-4.7` `reasoning_effort=xhigh`, `fast=false` / `GLADOS_REVIEW_MODEL`) — dry technical findings. The prompt is a port of the superpowers `code-reviewer` template: checklist over plan alignment, code quality, architecture, testing, and production readiness, and every critical/high issue must be reported. If `findings` is empty, skip verify and run a GLaDOS voice rewrite of the summary (`buildVoicePrompt`) on the same model.
2. **Verify** (`buildVerifyPrompt`, same default model, fresh context) — re-read callees, drop disproven candidates, rewrite kept text in GLaDOS voice. With the PR context block present, a candidate may be dropped when the author explained it as a deliberate choice **and** the code confirms it (both cited); a comment alone never disproves a critical/high candidate. Candidate IDs let `mergeVerifiedFindings()` restore the original anchors and cap severity; unknown or duplicate IDs fail the review. Dropped candidates are returned in `dropped` with evidence; a `critical`/`high` candidate dropped without evidence is restored with its draft severity and body (`undisprovenBlockers()`), and one lowered below `high` without `evidence` keeps its draft severity. Evidence is checked only for visible text, not for truth — the dropped-candidate log lines are the audit trail. Unknown, duplicate, or kept-and-dropped ids in `dropped` fail the review. `GLADOS_VERIFY_MODEL` overrides the verify pass.

**Severity:** `critical` = bugs, security, data loss, broken functionality. `high` = architecture problems, missing functionality, poor error handling, unhandled edge cases, test gaps for changed behavior. `medium`/`low` = style, optimization, docs polish.

When composed with replies, settled findings (original body + agreement reason) are injected as `extraContext` into both `buildReviewPrompt()` and `buildVerifyPrompt()` alongside `prContext`. Exact repeats are suppressed before verification and again before posting. Open/disagreed threads do **not** suppress new findings in code; the prompt only asks not to repeat them verbatim.

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
| PR context budget, tiers, rendering | `review/context.ts` → `formatPrContext()` / `PR_CONTEXT_BUDGET` |
| PR context sources | `github/pr-context.ts` → `fetchPrContext()` |
| Severity levels | `review/payload.ts` → `SEVERITIES` + `Severity` |
| GLaDOS voice | `review/payload.ts` → `buildVerifyPrompt()`; `applyPersonality()` still wraps at post time |
| Thread reply prompt / classification / suppress | `thread-replies/logic.ts` |
| Mention detection / prompt / reply body | `thread-replies/mentions.ts` |
| Phase A + compose with review | `thread-replies/process.ts` |
| Core review wiring | `review/process.ts` (no business logic) |
| Clone / lock / cleanup | `git/workspace.ts` |
| GitHub I/O | `github/` |

Tune **draft prompt**, **verify prompt**, **voice prompt**, **thread-reply prompt**, **mention prompt**, and **personality** independently.

Design detail: `docs/superpowers/specs/2026-08-05-review-thread-replies-design.md`, `docs/superpowers/specs/2026-10-11-pr-context-and-mentions-design.md`.

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
| `GLADOS_TOKEN` | GitHub API (search, notifications, clone auth, PR context reads, reviews, thread reply/resolve, conversation comments) |
| `CURSOR_API_KEY` | Cursor SDK local agent runs |
| `GLADOS_REVIEW_MODEL` | Optional draft-pass model (default `grok-4.7`, `reasoning_effort=xhigh`, `fast=false`) |
| `GLADOS_VERIFY_MODEL` | Optional verify-pass model (default `grok-4.7`, `reasoning_effort=xhigh`, `fast=false`) |

`GLADOS_TOKEN` needs access to arbitrary repos that send review requests (`repo` scope or equivalent). Resolving conversations additionally requires being the PR author **or** having write access on the repo — when that fails, agreement still settles for the following full review but Phase A stays incomplete for retry.
