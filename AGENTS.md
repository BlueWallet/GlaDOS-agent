# cursor-glados — agent guide

GLaDOS polls GitHub for review-request notifications, clones each PR locally, runs a Cursor SDK agent review, and posts the result back to GitHub (summary + inline comments, approve or request changes).

TypeScript, ESM (`"type": "module"`), Node ≥ 22.13. Run scripts with `tsx`.

## Commands

```bash
export GLADOS_TOKEN='ghp_...'      # GitHub PAT: notifications + repo + pull_requests
export CURSOR_API_KEY='cursor_...'

npm run notifications              # poll review_requested notifications, review each PR
npm run notifications -- --all     # include read notifications
npm run smoke                      # local Cursor SDK smoke test (cwd = this repo)
npm run typecheck
```

`@connectrpc/connect-node` is required at runtime by `@cursor/sdk` but is not bundled — keep it in `package.json`.

## Layout

Only `src/cli/` contains runnable entrypoints. Everything else is library code imported by CLI or other modules.

```
src/
  cli/
    notifications.ts    # entrypoint: list notifications → review each review_requested
    smoke.ts            # entrypoint: one-shot local Agent.prompt smoke test

  types.ts              # NotificationThread, PullRequestRef

  git/
    workspace.ts        # clone repo to temp dir, fetch + checkout PR branch

  github/
    notifications.ts    # listNotifications() — paginated /notifications API
    pr.ts               # parsePullRequest(), subjectUrlToWebUrl()
    reviews.ts          # postGithubReview() — createReview with inline comments

  review/
    process.ts          # processReviewRequest() — orchestrates full review flow
    agent.ts            # runAgentReview() — Cursor SDK Agent.prompt on local cwd
    payload.ts          # prompt, JSON parse, GitHub review formatting, personality hook
```

## Review flow

```
cli/notifications.ts
  → github/notifications.listNotifications()
  → filter reason === "review_requested"
  → review/process.processReviewRequest()  (per notification)
       → github/pr.parsePullRequest()
       → git/workspace.preparePrWorkspace()   # /tmp/glados-*/<repo>
       → review/agent.runAgentReview()        # local Agent.prompt
       → review/payload.buildGithubReview()   # APPROVE vs REQUEST_CHANGES
       → github/reviews.postGithubReview()
       → rm temp workspace
```

**Approve vs request changes:** `critical` or `high` findings → `REQUEST_CHANGES`; otherwise `APPROVE`.

**Inline comments:** findings with `path` + `line` become review comments (`side: RIGHT`). Unanchored findings go in the review body. If GitHub rejects inline comments (422), falls back to summary-only.

## Key extension points

| What | Where |
|------|--------|
| Reviewer instructions / JSON schema | `review/payload.ts` → `buildReviewPrompt()` |
| Severity levels (single source of truth) | `review/payload.ts` → `SEVERITIES` const + `Severity` type |
| GLaDOS voice before posting | `review/payload.ts` → `applyPersonality()` |
| Clone/checkout behavior | `git/workspace.ts` |
| GitHub API (notifications, PR parse, post review) | `github/` |
| Orchestration only — no business logic | `review/process.ts` |

Tune the **review prompt** and **personality** independently: prompt asks for structured JSON; `applyPersonality()` rewrites text at post time.

## Conventions

- **ESM imports** use `.js` extensions in TypeScript source (`import x from "./foo.js"`).
- **New runnable scripts** go in `src/cli/` only. Wire them in `package.json` scripts.
- **New library code** goes in the matching domain folder (`github/`, `git/`, `review/`), not a generic `utils/`.
- **Keep modules small:** `agent.ts` = SDK only, `payload.ts` = pure data/prompt/formatting, `process.ts` = wiring.
- **Minimize scope** on changes — match existing style, no over-abstraction.

## Environment

| Variable | Used for |
|----------|----------|
| `GLADOS_TOKEN` | GitHub API (notifications, clone auth, post reviews) |
| `CURSOR_API_KEY` | Cursor SDK local agent runs |

`GLADOS_TOKEN` needs access to arbitrary repos that send review requests (`repo` scope or equivalent fine-grained permissions).
