/**
 * The P3 strings the always-loaded code needs (F6 phase 1): the fold action
 * in a message's actions, the argument types the outline and the map name,
 * and the fold error texts. The rest loads with the lazy parts (`p3-messages.ts`).
 */
export const enP3 = {
  "message.foldFrom": "Fold from here…",
  "tag.kind.question": "Question",
  "tag.kind.idea": "Idea",
  "tag.kind.pro": "For",
  "tag.kind.con": "Against",
  "tag.kind.decision": "Decision",
  "tag.anchor": "forks from a {kind}",
  "map.nodeTag": "{name}, {tag}",
  "error.foldNotFound": "This fold no longer exists.",
  "error.foldOverlap": "This range overlaps another fold.",
  "error.foldLimit": "This line has reached {limit} folds.",
  "error.invalidFold": "A fold takes 2–200 finished messages.",
  "message.diverge": "Give me directions…",
  "error.comparisonNotFound": "This comparison no longer exists.",
  "error.comparisonNotReady": "The comparison is not written yet.",
  "error.comparisonDecided": "This comparison was already decided.",
  "error.invalidComparison": "Compare 2–5 open branches of the same line.",
  "preview.block.memory": "Memory (across conversations)",
  "error.memoryNotFound": "This memory no longer exists.",
  "error.memorySuperseded": "This memory was replaced; change the current one instead.",
  "error.embedderUnavailable": "The memory service is unavailable for now; try again later.",
  "error.invalidMemory": "A memory needs a kind, some text and an importance of 1–10.",
} as const;
