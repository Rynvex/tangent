/**
 * Reading the model catalog of `GET /capabilities` (G1): a model's display
 * name, status and reasoning efforts, and whether its provider is ready.
 * Older servers send none of it; then every model shows by its id, takes no
 * effort and its provider's readiness is unknown (null).
 */
import type { Capabilities, CapabilityModelDetail, ModelStatus } from "./capabilities";

/** The reasoning efforts a client may ask for, least to most (the server keeps the ones a model takes). */
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** One provider / model pair with what the server says about it. */
export interface ModelInfo {
  provider: string;
  model: string;
  /** The display name, or the model id when the server gives none. */
  label: string;
  status: ModelStatus | null;
  /** Empty when the model takes no reasoning effort (or the server does not say). */
  effortLevels: readonly string[];
  /** null when the server does not say whether the provider can run. */
  ready: boolean | null;
  /** Why the provider is not ready, when the server says. */
  reason: string | null;
}

function detailOf(capabilities: Capabilities | null | undefined, provider: string, model: string): { detail: CapabilityModelDetail | null; ready: boolean | null; reason: string | null } {
  const group = capabilities?.models?.find((entry) => entry.provider === provider);
  return {
    detail: group?.details?.find((item) => item.model === model) ?? null,
    ready: group?.ready ?? null,
    reason: group?.reason ?? null,
  };
}

/** What the catalog says about a provider / model pair (listed or not). */
export function modelInfo(capabilities: Capabilities | null | undefined, provider: string, model: string): ModelInfo {
  const { detail, ready, reason } = detailOf(capabilities, provider, model);
  return { provider, model, label: detail?.displayName || model, status: detail?.status ?? null, effortLevels: detail?.effortLevels ?? [], ready, reason };
}

/** Every listed model with its info, in the server's order; null when the server lists none. */
export function modelInfos(capabilities: Capabilities | null | undefined): ModelInfo[] | null {
  if (!capabilities?.models) return null;
  return capabilities.models.flatMap((entry) => entry.models.map((model) => modelInfo(capabilities, entry.provider, model)));
}

/** The effort to show for a model: `effort` when the model takes it, else null. */
export function effectiveEffort(info: Pick<ModelInfo, "effortLevels">, effort: string | null | undefined): string | null {
  return effort && info.effortLevels.includes(effort) ? effort : null;
}
