/**
 * The P2 strings the always-loaded code needs (F5): pinning from a message's
 * actions, the relate action and the B9 error texts. The rest of the P2
 * wording loads with the lazy parts that use it (`p2-messages.ts`).
 */
export const enP2 = {
  "message.pin": "Pin",
  "message.unpin": "Unpin",
  "message.pinned": "Pinned",
  "message.pinnedSent": "Pinned · always sent",
  "preview.block.branch_conclusions": "Other branches' conclusions",
  "message.relate": "Relate…",
  "result.mergedInto": "Combined into “{title}”.",
  "result.mergedIntoLink": "Go to “{title}”",
  "branch.mergedInto": "Combined into “{title}”",
  "branch.mergedIntoGone": "Combined into a branch that is gone",
  "pin.failed": "Not pinned: {reason}",
  "error.goalNotFound": "This conversation has no goal.",
  "error.relationNotFound": "This relation no longer exists.",
  "error.relationExists": "These two are already related.",
  "error.relationLimit": "This conversation has reached {limit} relations.",
  "error.memoLimit": "This conversation has reached {limit} memos. Delete some first.",
} as const;
