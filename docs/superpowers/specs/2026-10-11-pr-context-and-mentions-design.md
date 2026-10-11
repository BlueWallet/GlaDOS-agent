# PR context + mention replies — design

The review agent used to get only the PR URL and a checkout. It now also gets a
capped, untrusted-marked **PR context** block (title, description, base branch,
author, linked issues, every review including GLaDOS's own, the conversation,
every review thread). GLaDOS also answers `@mention`s in the PR conversation
and in review threads it did not start.

Builds on `2026-08-05-review-thread-replies-design.md`.

## Decisions

| Topic | Choice |
|-------|--------|
| Context sources | All: PR header, linked issues (closing references), reviews, issue comments, review threads (own and others') |
| Where it goes | Both draft and verify prompts, fenced as `BEGIN_UNTRUSTED_PR_CONTEXT … END_UNTRUSTED_PR_CONTEXT` |
| Budget | 50k chars, tiered; tier 0 never omitted |
| Reactions | `@login` in conversation → one consolidated issue comment; `@login` in a foreign thread → plain thread reply |
| Foreign threads | Never agreed with or resolved; once GLaDOS replied, any later human comment keeps the thread awaiting |
| Conversation | Only explicit mentions count (flat thread; no "engaged" continuation) |
| Bots | Bot authors (`author.__typename == "Bot"`) never trigger a foreign-thread or conversation reply; in an engaged foreign thread a bot comment counts only if it mentions GLaDOS. Prevents bot-to-bot loops |
| Closed / merged PRs | No foreign-thread or conversation replies (own threads still answered) |
| Folder | Everything stays in `src/thread-replies/`; context fetch in `src/github/`, context format in `src/review/` |

## PR context block

`src/github/pr-context.ts` → `fetchPrContext()`: three parallel paginated
GraphQL reads (PR core + `closingIssuesReferences`, reviews, issue comments) plus
`listReviewThreads()`. `src/review/context.ts` → `formatPrContext()` renders it.

Per body: strip **all** HTML comments (PR-template boilerplate and GLaDOS
control markers, without the formatter knowing the markers) → trim → escape
`<>&` and break `BEGIN_/END_UNTRUSTED` fence tokens (`END_UNTRUSTED…`)
→ truncate after escaping (4k; 12k for the PR body; linked issues shrink so
header + issues fit in half the budget). Labels: `alice (PR author)`,
`glados (you, GLaDOS)`, `ghost`.

Dropped before tiering: `PENDING` reviews (the viewer's own unsubmitted draft)
and `COMMENTED` reviews with an empty body (shells for inline comments, which
arrive via threads). Minimized issue comments are skipped.

Tiers (lower wins; within a tier newest first; greedy fill):

| Tier | Items |
|------|-------|
| 0 | Header, description, linked issues — never omitted |
| 1 | Own unresolved threads |
| 2 | Own reviews |
| 3 | Others' reviews |
| 4 | Others' unresolved threads |
| 5 | Issue comments |
| 6 | Resolved threads |

Rendered in a fixed order (header, issues, reviews, conversation, threads),
chronological within a section, `[N older items omitted]` per section,
`(none)` for empty sections.

Prompt rules added with the block: diff against the named base branch;
discussion statements are claims, not proof; do not repeat verbatim a finding
already in an own still-open thread. The verify pass may drop a candidate when
the author explained it as deliberate **and** the code confirms it, citing
both; a comment alone never disproves a critical or high candidate.

The composer fetches the block **after** Phase A so fresh GLaDOS replies are in
it. Fetch failure throws; the review request stays pending for the next run.

## Foreign threads

`threadReplyKind(thread)` = `own` when the root comment is GLaDOS's, else
`foreign`. `isAwaitingThread` is unchanged and only true for `own`.

```
isAwaitingForeignThread(thread, login):
  comments non-empty, !isResolved, kind == foreign
  engaged = some non-root GLaDOS comment carries a reply-to marker
  engaged  → a human comment after the acknowledged id   (shared with own threads)
  !engaged → some non-GLaDOS comment mentionsLogin(body, login)
```

`mentionsLogin`: whole handle `@login` (`[A-Za-z0-9-]` boundary,
case-insensitive), ignoring fenced blocks, inline code, quoted lines, and
`/@login` / `x@login` forms.

Agent decision `"reply"` is required for foreign threads and rejected for own
ones. `applyThreadDecision` derives the kind from the thread, never from the
agent, and the foreign branch never resolves. `findAgreementComment` also
requires an own root, so a forged agree marker cannot settle a human's thread.
Snapshot assertion takes the awaiting predicate matching the kind.

## Conversation mentions

```
acknowledgedIds(comments, login) = every reply-to id in GLaDOS-authored comments
isAwaitingMention(c) = author != login && !isMinimized
                    && mentionsLogin(c.body, login) && c.id ∉ acknowledgedIds
```

One agent run per wake-up answers every awaiting mention in a single issue
comment carrying one `<!-- glados:reply-to:<id> -->` per answered id. The
prompt carries the PR context block plus the awaiting comments as untrusted
JSON. Race safety: snapshot the full conversation right before the mention
agent runs (after thread replies, so unrelated chatter during that run does not
count); re-fetch before the write and skip the post (Phase A incomplete, no
throw — the full review must still land) if any comment was added, edited, or
minimized; after posting, re-fetch and leave Phase A incomplete if new
mentions arrived.

Control markers are stripped from agent output until the text stops changing,
so nested fragments cannot reassemble into a marker.

## Flow

```
cli/notifications.ts
 ├─ review-requested PRs → processPrReviewWithThreadReplies()
 │    1. withPrWorkspace()
 │    2. processReviewThreads()        # own + foreign threads, then mentions
 │    3. loadPrContextBlock()          # after replies
 │    4. runAgentReview(+ prContext + settled)
 │    5. suppress + sanitize + post
 │
 └─ PullRequest notification wake-up
      → processPrThreadReplies()       # clone only if threads or mentions await
      → markNotificationDone() only if complete
```

## Out of scope

- Mentions inside the PR description or review summary bodies
- Replies on closed or merged PRs
- Rate limiting of mention-triggered agent runs (anyone with access can trigger one)
