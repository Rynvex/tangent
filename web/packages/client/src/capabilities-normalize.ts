/**
 * Reading `GET /capabilities` (F20a: apart from the feature checks, which the
 * main bundle needs, so the reader and the wire helpers load with the client
 * that calls it). `capabilities.ts` re-exports `normalizeCapabilities`.
 */
import {
  AI_FEATURE_MODES,
  AI_FEATURES,
  FALLBACK_AI_MODE,
  FEATURE_NAMES,
  type Capabilities,
  type CapabilityFeature,
  type CapabilityModelDetail,
  type CapabilityModels,
  type FeatureName,
} from "./capabilities";
import { isObject, list, obj, oneOf, str, strings } from "./wire";

function isFeatureName(value: unknown): value is FeatureName {
  return typeof value === "string" && (FEATURE_NAMES as readonly string[]).includes(value);
}

function normalizeFeature(raw: unknown): CapabilityFeature[] {
  const entry = obj(raw);
  if (!isFeatureName(entry.name)) return [];
  const enabled = entry.enabled === true;
  if (AI_FEATURES.has(entry.name) && !enabled && entry.mode === "off") return [{ name: entry.name, enabled, mode: "off" }];
  if (!AI_FEATURES.has(entry.name) || !enabled) return [{ name: entry.name, enabled }];
  return [{ name: entry.name, enabled, mode: oneOf(entry.mode, AI_FEATURE_MODES, FALLBACK_AI_MODE) }];
}

/**
 * Keeps the known features; unknown names (a newer server) are dropped, a
 * `mode` on a non-AI or disabled feature is ignored and an enabled AI feature
 * without a valid mode counts as `manual`.
 */
const MODEL_STATUSES = ["current", "legacy"] as const;

/** One model's detail (G1), or nothing when it names no listed model; unknown statuses and empty fields are left out. */
function normalizeModelDetail(raw: unknown, listed: readonly string[]): CapabilityModelDetail[] {
  const entry = obj(raw);
  const model = str(entry.model);
  if (!listed.includes(model)) return [];
  const displayName = str(entry.displayName).trim();
  const status = oneOf(entry.status, [...MODEL_STATUSES, ""], "");
  const effortLevels = [...new Set(strings(entry.effortLevels).filter((level) => level !== ""))];
  return [{ model, ...(displayName ? { displayName } : {}), ...(status ? { status } : {}), ...(effortLevels.length > 0 ? { effortLevels } : {}) }];
}

function normalizeModels(raw: unknown): CapabilityModels[] {
  const entry = obj(raw);
  const provider = str(entry.provider);
  const models = Array.isArray(entry.models) ? entry.models.filter((model): model is string => typeof model === "string" && model !== "") : [];
  if (provider === "" || models.length === 0) return [];
  const ready = typeof entry.ready === "boolean" ? { ready: entry.ready } : {};
  const reason = str(entry.reason) ? { reason: str(entry.reason) } : {};
  const seen = new Set<string>();
  const details = list(entry.details, (item) => normalizeModelDetail(item, models))
    .flat()
    .filter((detail) => !seen.has(detail.model) && Boolean(seen.add(detail.model)));
  return [{ provider, models, ...ready, ...reason, ...(details.length > 0 ? { details } : {}) }];
}

export function normalizeCapabilities(raw: unknown): Capabilities {
  const body = obj(raw);
  const permissions = isObject(body.permissions) ? { permissions: { canWrite: body.permissions.canWrite === true } } : {};
  const models = Array.isArray(body.models) ? { models: list(body.models, normalizeModels).flat() } : {};
  return { features: list(body.features, normalizeFeature).flat(), ...permissions, ...models };
}
