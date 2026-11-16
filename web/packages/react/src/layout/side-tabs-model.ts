import { hasInbox, isFeatureOn, type Capabilities } from "@tangent/client";

export const SIDE_TAB_IDS = ["structure", "notes", "inbox"] as const;
export type SideTabId = (typeof SIDE_TAB_IDS)[number];

/** Narrows an unknown tab value (Base UI hands back `unknown`). */
export function isSideTabId(value: unknown): value is SideTabId {
  return typeof value === "string" && (SIDE_TAB_IDS as readonly string[]).includes(value);
}

/**
 * The side panel's tabs for these capabilities (handoff §9-1, DESIGN §12):
 * 結構 always; 紀要 when notes (or memos, F10: then it is 備忘; or the glossary, F19: then 名詞表) are on; 待處理 only when a P1 feature that
 * fills it is on — parking, the suggestion inbox (`suggestions`, B8) or open
 * loops. Turned-off features remove their tab entirely. Before the
 * capabilities load, only 結構 shows.
 */
export function sideTabsFor(capabilities: Capabilities | null | undefined): SideTabId[] {
  if (!capabilities) return ["structure"];
  return SIDE_TAB_IDS.filter((id) => id === "structure" || (id === "notes" && (isFeatureOn(capabilities, "notes") || isFeatureOn(capabilities, "memo") || isFeatureOn(capabilities, "glossary"))) || (id === "inbox" && hasInbox(capabilities)));
}
