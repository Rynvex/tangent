/**
 * The decompose panel's pure parts (F13 S4): which cards show for the
 * features that are on, how many suggestions there are, the messages a
 * detour covers and where a split into a new conversation would start.
 */
import { sortBySeq, type ChapterCutSuggestion, type DecomposePlan, type DetourRange, type Message } from "@tangent/client";

/** What the panel may offer: each action needs its feature (and writing); reading needs nothing. */
export interface DecomposeAbilities {
  write: boolean;
  fold: boolean;
  chapters: boolean;
  parking: boolean;
  relations: boolean;
  spinoff: boolean;
  /** Tags belong to main lines: the line on screen, or its main line, can take them. */
  tags: boolean;
}

/** The server's purpose without its "了解：" / "Look into: " opening, for the card's quote. */
export function detourTopic(purpose: string): string {
  return purpose.replace(/^(了解：|Look into: )/, "");
}

/** The ids of the messages a range covers on this line, oldest first ([] when an end is gone). */
export function rangeMessageIds(messages: readonly Message[], fromId: string, toId: string): string[] {
  const ordered = sortBySeq(messages);
  const from = ordered.findIndex((message) => message.id === fromId);
  const to = ordered.findIndex((message) => message.id === toId);
  if (from < 0 || to < from) return [];
  return ordered.slice(from, to + 1).map((message) => message.id);
}

/** A split worth offering: the last topic change that is not the line's opening (#3 or later). */
export function spinoffCandidate(cuts: readonly ChapterCutSuggestion[], numbers: ReadonlyMap<string, number>): ChapterCutSuggestion | null {
  return [...cuts].reverse().find((cut) => cut.reason === "topic_shift" && (numbers.get(cut.messageId) ?? 0) >= 3) ?? null;
}

/** The cards that show: a card with nothing it may do or say is left out. */
export function visibleCards(plan: DecomposePlan, tags: readonly string[], abilities: DecomposeAbilities, spinoff: ChapterCutSuggestion | null) {
  return {
    detours: plan.detourRanges.length > 0,
    chapters: plan.chapterCuts.length > 0 && abilities.chapters,
    tagsAndSeeds: (tags.length > 0 && abilities.tags) || (plan.seedCandidates.length > 0 && abilities.parking),
    related: plan.relatedLines.length > 0 || (spinoff !== null && abilities.spinoff && abilities.write),
  };
}

/** How many suggestions the panel holds (the banner says the same): each detour, the cuts, the tags, each seed, each related line. */
export function countSuggestions(plan: DecomposePlan, tags: readonly string[], abilities: DecomposeAbilities): number {
  return (
    plan.detourRanges.length +
    (plan.chapterCuts.length > 0 && abilities.chapters ? 1 : 0) +
    (tags.length > 0 && abilities.tags ? 1 : 0) +
    (abilities.parking ? plan.seedCandidates.length : 0) +
    plan.relatedLines.length
  );
}

/** The detours whose two ends are still on the line (a detour already moved, or changed since, is gone). */
export function detourAvailable(detour: DetourRange, messages: readonly Message[]): boolean {
  return rangeMessageIds(messages, detour.fromMessageId, detour.toMessageId).length > 0;
}
