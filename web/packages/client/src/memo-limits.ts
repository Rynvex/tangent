/**
 * The memo limits on their own (F20a): the conversation's 記成備忘 checks them
 * from the main bundle, the memo routes' readers (`memo-routes.ts`, which
 * re-exports these) load with the memo UI.
 */

/** `GET /memos` limits; the domain defaults when a body lacks them. */
export interface MemoLimits {
  maxTotal: number;
  maxRunes: number;
}

export const DEFAULT_MEMO_LIMITS: MemoLimits = { maxTotal: 500, maxRunes: 4000 };
