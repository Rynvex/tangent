/**
 * Feature modules (DESIGN §11, docs/design/EXTENSIONS.md) and `GET /capabilities`.
 *
 * Item shape decided in DESIGN §12: `{name, enabled, mode?}`, `mode` only on
 * features that have one (`summary` and `branch_suggest` report "off" when
 * disabled; see route.capabilities.json).
 */
export { normalizeCapabilities } from "./capabilities-normalize";

/** Every feature module of EXTENSIONS.md, in table order. */
export const FEATURE_NAMES = [
  "notes",
  "chapters",
  "aside",
  "summary",
  "card_draft",
  "branch_suggest",
  "leaf",
  "spinoff",
  "parking",
  "rebalance",
  "fisheye",
  "group",
  "relations",
  "goal",
  "open_loops",
  "memory",
  // B13: memos on a node that never go to the AI (on or off).
  "memo",
  // B24: a conversation's glossary; only the terms reach the AI (on or off).
  "glossary",
  "ibis",
  "diverge",
  "fold",
  // B5: full-text search (needs pg_trgm; on or off).
  "search",
  // B8: the suggestion inbox; on when any feature that proposes suggestions is on (no mode).
  "suggestions",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** off / run when the user asks / AI proposes and the user confirms / AI acts. */
export type FeatureMode = "off" | "manual" | "suggest" | "auto";

/** The modes an enabled AI feature reports; "off" is `enabled: false`. */
export const AI_FEATURE_MODES = ["manual", "suggest", "auto"] as const;
export type AiFeatureMode = (typeof AI_FEATURE_MODES)[number];

/** What an enabled AI feature without a valid mode is treated as: nothing runs unless the user asks. */
export const FALLBACK_AI_MODE: AiFeatureMode = "manual";

/**
 * Features that report a mode; the rest are only on or off. `card_draft` uses
 * AI but has no mode (DESIGN §12, B3 phase 2: the client decides when to draft).
 */
export const AI_FEATURES: ReadonlySet<FeatureName> = new Set<FeatureName>([
  "summary",
  "branch_suggest",
  "leaf",
  "rebalance",
  "group",
  "relations",
  "goal",
  "memory",
  "ibis",
  "diverge",
  "fold",
]);

/** One feature as `GET /capabilities` lists it (DESIGN §12): `mode` only on AI features ("off" when a disabled one reports it). */
export interface CapabilityFeature {
  name: FeatureName;
  enabled: boolean;
  mode?: AiFeatureMode | "off";
}

/** What this identity may do (B4.1); absent from servers before it. */
export interface CapabilityPermissions {
  canWrite: boolean;
}

/** Whether a model is the current generation or an older one (G1). */
export type ModelStatus = "current" | "legacy";

/** What the server says about one listed model (G1); every field but `model` is optional. */
export interface CapabilityModelDetail {
  model: string;
  /** How to name the model; absent: its id. */
  displayName?: string;
  status?: ModelStatus;
  /** The reasoning efforts the server passes on for this model, least to most; absent: none. */
  effortLevels?: string[];
}

/** One provider and the models the server allows with it (B5); `ready`, `reason` and `details` since G1. */
export interface CapabilityModels {
  provider: string;
  models: string[];
  /** Whether the provider can run now (a CLI found on the server); absent when the server does not say. */
  ready?: boolean;
  /** Why it is not ready (e.g. "binary not found"). */
  reason?: string;
  /** Details of some of `models`. */
  details?: CapabilityModelDetail[];
}

/** `GET /capabilities` body. */
export interface Capabilities {
  features: CapabilityFeature[];
  /** Present when the server reports it (B4.1); then it decides read-only, not a 403. */
  permissions?: CapabilityPermissions;
  /** The provider / model pairs a line or branch may use (B5); absent from older servers. */
  models?: CapabilityModels[];
}

/** Every allowed provider / model pair, or null when the server does not list them (then only "same as the parent" is offered). */
export function modelChoices(capabilities: Capabilities | null | undefined): Array<{ provider: string; model: string }> | null {
  if (!capabilities?.models) return null;
  return capabilities.models.flatMap((entry) => entry.models.map((model) => ({ provider: entry.provider, model })));
}

/** true / false when the server says whether this identity may write, null when it does not say. */
export function canWrite(capabilities: Capabilities | null | undefined): boolean | null {
  return capabilities?.permissions ? capabilities.permissions.canWrite : null;
}

/** True when the feature is listed and enabled. */
export function isFeatureOn(capabilities: Capabilities | null | undefined, name: FeatureName): boolean {
  return capabilities?.features.find((feature) => feature.name === name)?.enabled === true;
}

/** The mode of a feature: "off" when not enabled; an enabled non-AI feature reports "auto". */
export function featureMode(capabilities: Capabilities | null | undefined, name: FeatureName): FeatureMode {
  const feature = capabilities?.features.find((item) => item.name === name);
  if (!feature?.enabled) return "off";
  return feature.mode ?? (AI_FEATURES.has(name) ? FALLBACK_AI_MODE : "auto");
}
