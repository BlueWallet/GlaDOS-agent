/**
 * Replies feature: own review threads, foreign threads on mention, and the PR
 * conversation on mention (Phase A), composed with the full review.
 *
 * Public surface — import only from here outside this folder.
 * To disable or replace: swap CLI calls and delete `src/thread-replies/`.
 * The list functions in `src/github/threads.ts` and `src/github/comments.ts`
 * stay (core review context); their mutations may go.
 */
export {
  processPrReviewWithThreadReplies,
  processPrThreadReplies,
} from "./process.js";
