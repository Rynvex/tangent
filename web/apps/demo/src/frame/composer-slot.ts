/** What sits under the conversation: a bar, the composer, or nothing yet. */
export type ComposerSlot = "readOnly" | "none" | "result" | "archived" | "composer";

export interface ComposerSlotInput {
  /** The identity cannot write anywhere. */
  readOnly: boolean;
  /** `/capabilities` has answered (or failed), so `readOnly` is final rather than the default. */
  permissionsLoaded: boolean;
  /** The line itself has loaded (until then it is unknown whether it still takes messages). */
  lineLoaded: boolean;
  /** The line is a branch that was brought back, discarded or promoted. */
  ended: boolean;
  /** The branch's view (for the result bar) has loaded. */
  branchLoaded: boolean;
  archived: boolean;
}

/**
 * Picks the slot so that a still-loading value never falls through to the
 * composer: unknown permissions or an unloaded line show nothing, and an
 * ended branch shows its result bar or, while that loads, nothing.
 */
export function composerSlot({ readOnly, permissionsLoaded, lineLoaded, ended, branchLoaded, archived }: ComposerSlotInput): ComposerSlot {
  if (readOnly) return "readOnly";
  if (!permissionsLoaded || !lineLoaded) return "none";
  if (ended) return branchLoaded ? "result" : "none";
  if (archived) return "archived";
  return "composer";
}
