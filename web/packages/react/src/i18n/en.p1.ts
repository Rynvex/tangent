/**
 * The P1 strings the always-loaded code needs (leaf kinds on the conclusion
 * card, the 停車 toasts, the B8 error texts, the feature's name). The rest of
 * the P1 wording loads with the lazy parts that use it (`p1-messages.ts`).
 */
export const enP1 = {
  "leaf.kind.conclusion": "Conclusion",
  "leaf.kind.decision": "Decision",
  "leaf.kind.answer": "Answer",
  "leaf.kind.dead_end": "Dead end",
  "leaf.kind.to_continue": "To continue",
  "leaf.kindPrefix": "{kind}: ",
  "parking.parked": "Parked · costs no tokens",
  "parking.emptyComposer": "Write the thought in the composer first, then park it.",
  "parking.tooLong": "A seed is at most {limit} characters; shorten it before parking.",
  "parking.failed": "Not parked: {reason}",
  "feature.suggestions": "Suggestion inbox",
  "error.seedNotOpen": "This seed was already expanded, noted or dropped.",
  "error.seedNotFound": "This seed no longer exists.",
  "error.seedLimit": "The parking lot is full ({limit} seeds). Expand, note or drop a few to make room.",
  "error.suggestionNotOpen": "This suggestion was already decided or has expired.",
  "error.suggestionNotFound": "This suggestion no longer exists.",
  "error.leafNotFound": "This branch has no ending.",
  "error.invalidLeaf": "The ending is not acceptable; check its kind and length.",
  // Spinoff links (B2), always loaded with the message list and the conversation.
  "message.spunOff": "Spun off into a new conversation",
  "marker.spunOffLink": "Spun off → “{title}”",
  "spinoff.from": "From: {title}",
  "message.spinoff": "Start a new conversation from here",
  "spinoff.fromGone": "From: {title} (conversation deleted)",
  "marker.spunOffGone": "Spun off → “{title}” (conversation deleted)",
} as const;
