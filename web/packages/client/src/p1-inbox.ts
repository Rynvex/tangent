/**
 * The P1 pieces the conversation needs on first render (F20a): a seed's text
 * from a message and the 待處理 tab's presence and count. The rest of P1
 * (`p1.ts`, which re-exports these) loads with the leaf, parking and inbox UI.
 */
import { isFeatureOn, type Capabilities } from "./capabilities";
import type { LineView } from "./types";

/** domain.DefaultLimits().Parking: one seed's text (the open seeds' limit is `SEED_OPEN_MAX`). */
export const SEED_TEXT_MAX = 500;
/** A seed parked from a message or a selection starts from this much of its text. */
export const SEED_FROM_MESSAGE_CHARS = 120;

/** Whitespace runs as one space, trimmed. */
export const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

/** A seed's starting text from a message or a selection: one line, at most `max` characters. */
export function seedFromText(text: string, max = SEED_FROM_MESSAGE_CHARS): string {
  return Array.from(flatten(text)).slice(0, max).join("");
}

/** 待處理 exists only with a P1 feature that fills it (DESIGN §12 F0): parking, the suggestion inbox or open loops. */
export function hasInbox(capabilities: Capabilities | null | undefined): boolean {
  return isFeatureOn(capabilities, "parking") || isFeatureOn(capabilities, "suggestions") || isFeatureOn(capabilities, "open_loops");
}

/**
 * The tab's count, from the main line's `LineView`: open seeds, open
 * suggestions and (B9) stale branches, each only while its feature is on
 * (the server counts them whatever the switches say).
 */
export function inboxCount(
  capabilities: Capabilities | null | undefined,
  mainLine: Pick<LineView, "openSeeds" | "openSuggestions"> & Partial<Pick<LineView, "staleBranches">> | null | undefined,
): number {
  if (!mainLine) return 0;
  const seeds = isFeatureOn(capabilities, "parking") ? mainLine.openSeeds : 0;
  const suggestions = isFeatureOn(capabilities, "suggestions") ? mainLine.openSuggestions : 0;
  const stale = isFeatureOn(capabilities, "open_loops") ? (mainLine.staleBranches ?? 0) : 0;
  return seeds + suggestions + stale;
}
