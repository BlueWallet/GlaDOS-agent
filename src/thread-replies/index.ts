/**
 * Review-thread replies feature (Phase A + compose with full review).
 *
 * Public surface — import only from here outside this folder.
 * To disable or replace: swap CLI calls and delete `src/thread-replies/`
 * (plus `src/github/threads.ts` if nothing else uses it).
 */
export {
  processPrReviewWithThreadReplies,
  processPrThreadReplies,
} from "./process.js";
