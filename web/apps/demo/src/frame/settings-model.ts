/** The settings page's feature list (A13), pure so the rules are tested without a browser. */
import { AI_FEATURES, FEATURE_NAMES, featureMode, type AiFeatureMode, type Capabilities, type FeatureName } from "@tangent/client";
import type { MessageKey } from "@tangent/react";

export type SettingsFeatureRow =
  | { kind: "core"; labelKey: MessageKey }
  /** On, without a mode (not an AI feature, or card drafts: DESIGN §12). */
  | { kind: "toggle"; name: FeatureName }
  | { kind: "mode"; name: FeatureName; mode: AiFeatureMode };

/** What can never be turned off (DESIGN §11 核心). */
const CORE_ROWS: readonly SettingsFeatureRow[] = [
  { kind: "core", labelKey: "settings.coreBranches" },
  { kind: "core", labelKey: "settings.coreOutline" },
  { kind: "core", labelKey: "settings.corePreview" },
];

/**
 * The core, then every enabled feature in EXTENSIONS.md order with its mode.
 * Off features are not listed (off = not rendered); `othersOff` says some are.
 * Every mode is the host's (DESIGN §12 F3): the page only shows them.
 */
export function featureRows(capabilities: Capabilities | null | undefined): { rows: SettingsFeatureRow[]; othersOff: boolean } {
  if (!capabilities) return { rows: [...CORE_ROWS], othersOff: false };
  const enabled = FEATURE_NAMES.filter((name) => featureMode(capabilities, name) !== "off");
  const rows = enabled.map((name): SettingsFeatureRow => {
    const mode = featureMode(capabilities, name);
    if (!AI_FEATURES.has(name) || mode === "off") return { kind: "toggle", name };
    return { kind: "mode", name, mode };
  });
  const listed = new Set(capabilities.features.filter((feature) => feature.enabled).map((feature) => feature.name));
  return { rows: [...CORE_ROWS, ...rows], othersOff: FEATURE_NAMES.some((name) => !listed.has(name)) };
}

/** The settings' four headings (F9 B.4), in order; the core rows head the first. */
export const FEATURE_GROUPS = ["navigation", "discussion", "learning", "background"] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

export const FEATURE_GROUP_KEYS: Readonly<Record<FeatureGroup, MessageKey>> = {
  navigation: "settings.groupNavigation",
  discussion: "settings.groupDiscussion",
  learning: "settings.groupLearning",
  background: "settings.groupBackground",
};

/** Every feature's heading (a Record, so a new feature must be given one). */
export const FEATURE_GROUP_OF: Readonly<Record<FeatureName, FeatureGroup>> = {
  aside: "navigation",
  chapters: "navigation",
  search: "navigation",
  spinoff: "navigation",
  parking: "navigation",
  open_loops: "navigation",
  branch_suggest: "discussion",
  leaf: "discussion",
  ibis: "discussion",
  diverge: "discussion",
  relations: "discussion",
  group: "discussion",
  rebalance: "discussion",
  notes: "learning",
  summary: "learning",
  card_draft: "learning",
  memo: "learning",
  glossary: "learning",
  fold: "learning",
  goal: "background",
  memory: "background",
  fisheye: "background",
  suggestions: "background",
};

export interface SettingsFeatureGroup {
  group: FeatureGroup;
  rows: SettingsFeatureRow[];
}

/** `featureRows` under the four headings; a heading with nothing on is left out. */
export function featureGroups(capabilities: Capabilities | null | undefined): { groups: SettingsFeatureGroup[]; othersOff: boolean } {
  const { rows, othersOff } = featureRows(capabilities);
  const groupOf = (row: SettingsFeatureRow): FeatureGroup => (row.kind === "core" ? "navigation" : FEATURE_GROUP_OF[row.name]);
  const groups = FEATURE_GROUPS.map((group) => ({ group, rows: rows.filter((row) => groupOf(row) === group) })).filter((entry) => entry.rows.length > 0);
  return { groups, othersOff };
}

/**
 * The three presets (F9 B.4) as `TANGENT_FEATURES` says them. The mock keeps
 * the same lists (`mockCapabilities`, scenario-nas.ts); the demo does not
 * import the mock for them, so a real build never carries it. A test keeps
 * the two equal.
 */
export const FEATURE_PRESETS = {
  standard: "notes,chapters,aside,summary:suggest,card_draft,branch_suggest:suggest,search,leaf:suggest,parking,spinoff,open_loops,memo,glossary,fold:suggest",
  research:
    "notes,chapters,aside,summary:suggest,card_draft,branch_suggest:suggest,search,leaf:suggest,parking,spinoff,rebalance:suggest,goal:suggest,relations:suggest,open_loops,group:suggest,ibis:suggest,fold:suggest,diverge:manual,memo,glossary",
  learning: "notes,chapters,aside,summary:auto,card_draft,search,leaf:suggest,memo,glossary,fold:suggest",
} as const;
export type FeaturePreset = keyof typeof FEATURE_PRESETS;
export const PRESET_ORDER: readonly FeaturePreset[] = ["standard", "research", "learning"];
export const PRESET_KEYS: Readonly<Record<FeaturePreset, MessageKey>> = {
  standard: "settings.presetStandard",
  research: "settings.presetResearch",
  learning: "settings.presetLearning",
};

export const isFeaturePreset = (value: string): value is FeaturePreset => Object.hasOwn(FEATURE_PRESETS, value);

/** The environment line a server needs for the preset (it reads it only at start). */
export const presetEnv = (preset: FeaturePreset) => `TANGENT_FEATURES=${FEATURE_PRESETS[preset]}`;

/** `name` → mode (null without one) of a `TANGENT_FEATURES` list. */
function parseFeatureList(list: string): Map<string, string | null> {
  return new Map(list.split(",").map((entry) => {
    const [name = "", mode] = entry.split(":");
    return [name, mode ?? null] as const;
  }));
}

/** The preset the server's features match exactly (names and modes, the inbox aside), else null. */
export function matchingPreset(capabilities: Capabilities | null | undefined): FeaturePreset | null {
  if (!capabilities) return null;
  const on = new Map<string, string | null>();
  for (const name of FEATURE_NAMES) {
    const mode = featureMode(capabilities, name);
    if (name === "suggestions" || mode === "off") continue;
    on.set(name, AI_FEATURES.has(name) ? mode : null);
  }
  return (
    PRESET_ORDER.find((preset) => {
      const wanted = parseFeatureList(FEATURE_PRESETS[preset]);
      return wanted.size === on.size && [...wanted].every(([name, mode]) => on.has(name) && (mode === null || on.get(name) === mode));
    }) ?? null
  );
}

/** The page's query string with another mock feature set (`?features=`), keeping the rest. */
export function featureSetSearch(search: string, set: "all" | "c1" | "core" | FeaturePreset): string {
  const params = new URLSearchParams(search);
  params.set("features", set);
  return `?${params.toString()}`;
}
