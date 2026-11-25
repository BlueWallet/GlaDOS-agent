# Review memory, scope rule, and impact severity — design

Lessons from a 16-round review of BlueWallet/Blueberry.kmp#88: GLaDOS had no memory of
earlier rounds (every thread was resolved by the author, never "agreed", so the settled
list was always empty), never saw owner decisions posted as PR comments, reported problems
in existing code paths the PR deliberately reused, and labelled by a rubric where any
unhandled edge case or test gap was blocking. The owner approved three changes.

## Decisions

| Topic | Choice |
|-------|--------|
| Settled by resolution | A GLaDOS thread is settled when it is resolved and `resolvedBy` is the PR author or a user with write, maintain, or admin permission. Any other resolver does not count. The agree-marker path stays. |
| Who is trusted | PR author (any permission), or `getCollaboratorPermissionLevel` reports `admin`/`write` permission or role `admin`/`maintain`/`write`. GLaDOS itself and bots (`[bot]` logins, `Bot` type) are never trusted. A permission lookup that fails counts as untrusted. |
| Re-raise suppression | Same path and (exact normalized body, or same topic). Topic = code identifiers (backtick spans, camelCase/snake_case/dotted words). Same topic: at least 2 shared identifiers and the overlap is at least 60% of the smaller set. Deterministic backstop; the prompt carries the main rule. |
| Owner decisions | Issue (conversation) comments and review-thread replies (not roots) by trusted users, excluding GLaDOS and bots, are passed to draft and verify prompts as owner decisions, newest kept first, each capped at 1,500 chars, total 12,000 chars, presented in chronological order, encoded as untrusted data. |
| Owner-decision rule | Do not re-raise findings the owner declined or deferred, and do not reopen an owner decision unless you show new evidence of concrete harm. |
| Earlier open findings | GLaDOS root findings that are not settled are listed (path, severity, truncated body; total 8,000 chars) so the no-escalation rule has data. They do not suppress anything. |
| Scope | Judge against the stated goal/spec (title, body, spec docs in the diff). Matching the current behaviour of an existing path the PR deliberately reuses is correct. Out-of-scope and pre-existing issues are dropped entirely — no finding, no follow-ups section. |
| Severity | critical: security issues, loss of funds, data loss, broken core functionality. high: wrong money/amount or signature handling, data loss, a crash or hang on a path users can actually hit. medium: a real bug on an unlikely path, or changed behaviour without a test. low: error messages, wording, docs, style. Blocking stays critical/high. |
| Calibration examples | A wrong error message when a parser rejects input is low. Accepting a signature that does not commit to the outputs is high. A missing test for a new branch is medium. A crash only reachable with a hand-crafted file the app never produces is medium. |
| No escalation | Do not raise the severity of a concern raised in an earlier round unless the code there got worse. |
| Message-only lowering | Verify may mark a kept finding `"messageOnly": true` when its only impact is user-facing text, wording, or docs. Then lowering a critical/high candidate to `low` is accepted without `evidence`. Other lowering below high still needs evidence. |

## Flow change

```
processPrReviewWithThreadReplies
  → loadThreadState: login, threads (+ resolvedBy), PR author, issue comments
  → trust set: author + permission lookups for candidate logins (cached per run)
  → Phase A (unchanged; resolved threads are never awaiting)
  → settled = agree-marker threads ∪ trusted-resolution threads
  → extraContext = settled context + owner decisions + earlier open findings
  → runAgentReview(extraContext, filter = suppressSettledFindings by path + topic)
```

`processPrThreadReplies` (notification wake-ups) keeps doing Phase A only; it does not
need comments or permissions.

## Files

- `src/github/threads.ts` — `resolvedBy { login }` in both thread queries → `ReviewThread.resolvedByLogin`.
- `src/github/comments.ts` — `listIssueComments()` (paginated REST) and `getPullRequestAuthor()`.
- `src/github/permissions.ts` — `isWriteAccess()` (pure) and `loadTrustedLogins()`.
- `src/thread-replies/logic.ts` — `listSettledFindings(threads, login, trusted?)`, `formatSettledContext` wording, topic suppression.
- `src/thread-replies/memory.ts` — pure: owner decisions and earlier open findings selection, bounds, formatting.
- `src/thread-replies/process.ts` — wiring.
- `src/review/payload.ts` — scope rule, rubric, no-escalation, `messageOnly`.
- `AGENTS.md` — severity, memory, and scope sections.

## Out of scope

Pinning the reviewed commit, delta-focused re-reviews, and verdict labelling (recommendations 1, 5, 6).

## Testing

Unit tests next to the code (`node:test`): trust classification, settled-by-resolution
(author, write user, untrusted resolver, unresolved, bot), topic suppression (reworded
repeat suppressed, different topic on same file kept, other file kept), owner-decision
filtering and bounds, prompt wording, `messageOnly` merge and parsing.
