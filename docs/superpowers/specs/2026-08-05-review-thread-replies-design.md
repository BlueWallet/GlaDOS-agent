# Review thread replies — design

GLaDOS must respond when humans reply on its review comment threads: agree (short reply + resolve) or disagree (explain on the thread). Settled agreements are never re-raised on later reviews of the same PR. Disagreements can continue indefinitely whenever someone replies after GLaDOS.

## Decisions

| Topic | Choice |
|-------|--------|
| Triggers | Reply notifications **and** full re-review |
| Who counts | Anyone who replies on the thread |
| After agree | Resolve thread; permanently suppress that issue for the PR |
| Notification, no pending review | Phase A only (reply/resolve); no new review |
| Open disagreements on re-review | May restate as new findings **and** continue the old thread |
| Architecture | Two-phase agent (threads, then optional full review) |
| Memory | GitHub thread state only (no local DB) |

## Flow

```
cli/notifications.ts
 ├─ review-requested PRs → processPrReviewWithThreadReplies()
 │    1. withPrWorkspace()
 │    2. processReviewThreads()      # Phase A (thread-replies/)
 │    3. runAgentReview(+ settled)   # core review/
 │    4. suppress + sanitize + post
 │
 └─ inbox: PullRequest notification wake-up
      → processPrThreadReplies() only
      → markNotificationDone() only after successful processing
```

## Phase A — thread replies

**Awaiting thread:** Root review comment authored by GLaDOS, thread unresolved, last comment not by GLaDOS.

**Agent:** Given thread history + current code (local checkout), return per-thread `{ threadId, decision: "agree"|"disagree", body }`.

Comment history is untrusted prompt data. Agent runs use a disposable HOME and
temp directory, a fixed parent workspace (so repository `.cursor` files cannot
become active policy), an environment allowlist, and Cursor sandboxing. The
agent may read code only; tests, builds, installers, package managers, and
repository scripts are forbidden.

**Actions:**
- Agree → post short reply, resolve thread (GraphQL `resolveReviewThread`).
- Disagree → post reply explaining why; leave unresolved.
- Every reply carries a hidden acknowledgment of the exact human comment it
  evaluated. If another human comment races before GLaDOS posts, the thread
  remains awaiting and is reconsidered on the next pass.
- If an agree marker exists but the thread is still unresolved, retry resolution
  without asking the agent or posting another reply.

Thread and comment connections must both be fully paginated so long-running
conversations are never truncated.

**Personality:** Same GLaDOS voice as review comments (via existing personality hook / prompt).

## Phase B — full review (review-requested only)

Inject **settled** threads into the review prompt: original finding text,
path/line, and the marked GLaDOS agreement explaining why it was settled. Rule:
do not re-raise those issues for this PR, even if resolution failed or the
thread was later unresolved (no revive if code changes). Exact repeated
findings are also removed after parsing; if removal occurs, regenerate the
summary so it cannot repeat the settled blocker.

Open / disagreed threads are **not** suppressors; new findings on the same topic are allowed.

## Modules

| Module | Responsibility |
|--------|----------------|
| `github/threads.ts` | List PR review threads (GraphQL), create thread reply, resolve thread; identify authenticated user |
| `thread-replies/` | Isolated feature folder (public API via `index.ts`) |
| `thread-replies/logic.ts` | Pure: awaiting vs settled classification; prompt/parse for Phase A; format settled context; suppress |
| `thread-replies/agent.ts` | `runThreadReplies()` for Phase A |
| `thread-replies/process.ts` | Phase A orchestration + `processPrReviewWithThreadReplies` composer |
| `review/` | Core PR review only — no thread-reply imports |
| `cli/notifications.ts` | Wires features; every PR notification is a Phase A wake-up |

Keep feature logic inside `thread-replies/`; GitHub I/O in `github/`; core
review stays replaceable without knowing about threads.

## GitHub API notes

- Threads + resolve: GraphQL (`pullRequest.reviewThreads`, `resolveReviewThread`).
- Replies: GraphQL `addPullRequestReviewThreadReply`, using the thread node ID.
  This avoids deprecated/overflow-prone numeric comment IDs.
- Settled detection: agree replies include a hidden marker
  (`<!-- glados:agree -->`) plus an acknowledgment marker appended only by
  controlled code. The agreement is valid only if no unacknowledged human
  comment preceded it. Root findings and model-provided markers do not count.
  A valid marker permanently settles the issue for this PR even if the thread
  is later unresolved; `isResolved` controls only whether GLaDOS needs to retry
  the resolve mutation.
- GitHub coalesces PR notifications, so every `PullRequest` notification is
  treated only as a wake-up to inspect complete thread state; do not rely on
  `subject.latest_comment_url`.
- Before replying, re-fetch complete thread histories and reject a batch if any
  comment was added or edited while the agent evaluated it. Re-fetch the target
  thread again immediately before each write.
- Serialize each PR with a local process lock so overlapping CLI runs cannot
  post duplicate or contradictory replies.
- Resolution is best-effort when `viewerCanResolve` is false (GitHub requires
  the PR author or repository write access). The agreement remains settled and
  later full reviews continue instead of becoming blocked, but Phase A remains
  incomplete and its notification is retained so resolution is retried if
  permissions later change.
- A failed Phase A leaves its notification unmarked so a later CLI run retries
  it.

## Out of scope

- Real-time streaming / webhooks (CLI poll remains the runner)
- Local durable store of findings
- Resolving threads GLaDOS did not agree on
- Changing APPROVE / REQUEST_CHANGES rules beyond “don’t re-raise settled items”
