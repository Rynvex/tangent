import type { Translate } from "../i18n";

/**
 * The global states of A14. `aiError` mirrors the `turn.retrying` event
 * (DESIGN §12: `{turnId, attempt, maxAttempts, nextRetryAt}`); times are
 * ISO strings or epoch milliseconds.
 */
export type StatusBannerState =
  | { kind: "reconnecting"; attempt: number; nextRetryAt?: string | number | null }
  | { kind: "aiError"; attempt: number; maxAttempts: number; nextRetryAt?: string | number | null; reason?: string }
  | { kind: "readonly" }
  | { kind: "limit"; limit: number };

export type BannerTone = "warning" | "destructive" | "neutral";

const MS_PER_SECOND = 1000;

function toMillis(at: string | number): number {
  return typeof at === "number" ? at : Date.parse(at);
}

/** Whole seconds until `at` (rounded up), never negative; null without a valid time. */
export function secondsUntil(at: string | number | null | undefined, now: number): number | null {
  if (at === null || at === undefined) return null;
  const target = toMillis(at);
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.ceil((target - now) / MS_PER_SECOND));
}

/** The countdown this state shows, if any. */
export function bannerCountdown(state: StatusBannerState, now: number): number | null {
  if (state.kind !== "reconnecting" && state.kind !== "aiError") return null;
  return secondsUntil(state.nextRetryAt, now);
}

export function bannerTone(state: StatusBannerState): BannerTone {
  if (state.kind === "aiError") return "destructive";
  if (state.kind === "readonly") return "neutral";
  return "warning";
}

/**
 * The visible message at `now`. With `live` false it includes the countdown;
 * with `live` true it is the stable sentence a screen reader hears once.
 */
export function bannerMessage(state: StatusBannerState, now: number, t: Translate, live = false): string {
  const seconds = live ? null : bannerCountdown(state, now);
  const counting = seconds !== null && seconds > 0;
  switch (state.kind) {
    case "reconnecting":
      return counting ? t("banner.reconnecting", { attempt: state.attempt, seconds }) : t("banner.reconnectingNow", { attempt: state.attempt });
    case "aiError": {
      const params = { attempt: state.attempt, maxAttempts: state.maxAttempts, reason: state.reason || t("banner.aiErrorReason") };
      return counting ? t("banner.aiError", { ...params, seconds }) : t("banner.aiErrorNow", params);
    }
    case "readonly":
      return t("banner.readonly");
    case "limit":
      return t("banner.limit", { limit: state.limit });
  }
}

/** The default action label, or null when the state has none (read-only). */
export function bannerActionLabel(state: StatusBannerState, t: Translate): string | null {
  if (state.kind === "reconnecting" || state.kind === "aiError") return t("banner.retryNow");
  if (state.kind === "limit") return t("banner.reviewBranches");
  return null;
}
