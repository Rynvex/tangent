/**
 * Drift hints (偏題) on their own (F20a): the transcript reads them on first
 * render, the rest of P2's logic (`p2.ts`, which re-exports these) loads with
 * the goal and relation UI.
 */
import type { BranchKind, Suggestion } from "./types";

/** A payload field as text ("" when it is not a string). */
export const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A drift hint (偏題): the reply it is about and the branch it proposes. */
export interface Drift {
  anchorMessageId: string;
  kind: Extract<BranchKind, "aside" | "investigate">;
  purpose: string;
  reason: string;
  goal: string;
}

/** A `drift` suggestion's payload; null for any other suggestion or one without its reply. */
export function driftOf(suggestion: Pick<Suggestion, "feature" | "kind" | "payload">): Drift | null {
  if (suggestion.feature !== "goal" || suggestion.kind !== "drift") return null;
  const payload = suggestion.payload;
  const anchorMessageId = text(payload.anchorMessageId);
  if (anchorMessageId === "") return null;
  return { anchorMessageId, kind: payload.kind === "aside" ? "aside" : "investigate", purpose: text(payload.purpose), reason: text(payload.reason), goal: text(payload.goal) };
}

/** The open drift hint of each reply (the newest when a reply has several): at most one per turn, under that reply. */
export function driftByMessage(suggestions: readonly Suggestion[]): Map<string, Suggestion> {
  const hints = new Map<string, Suggestion>();
  for (const suggestion of suggestions) {
    const drift = suggestion.status === "open" ? driftOf(suggestion) : null;
    if (!drift) continue;
    const current = hints.get(drift.anchorMessageId);
    if (!current || current.createdAt < suggestion.createdAt) hints.set(drift.anchorMessageId, suggestion);
  }
  return hints;
}
