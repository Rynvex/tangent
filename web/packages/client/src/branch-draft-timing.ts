/**
 * The card draft's timing constants, in a module of their own so the main
 * bundle's poll interval does not bring the draft flow and the card editor
 * along (F20a). `branch-draft-flow.ts` re-exports them.
 */

/** Server gives up on a draft after three minutes (Limits.Branch.DraftTimeout). */
export const DRAFT_TIMEOUT_MS = 3 * 60 * 1000;
/**
 * `startedAt` is the server's clock and `now` the browser's. The server turns
 * an overdue draft into "failed" itself (domain.EffectiveBranchDraftStatus),
 * so the client only gives up after this much extra margin for clock skew.
 */
export const DRAFT_CLOCK_SKEW_MS = 60 * 1000;
/** Poll while drafting; `branch.changed` events are the main signal. */
export const DRAFT_POLL_MS = 4000;
