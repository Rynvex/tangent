import { GitBranch, Lock, TriangleAlert, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/button";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { bannerActionLabel, bannerCountdown, bannerMessage, bannerTone, type BannerTone, type StatusBannerState } from "./status-banner-model";

export type { StatusBannerState } from "./status-banner-model";

const TICK_MS = 1000;

const TONES: Record<BannerTone, { surface: string; icon: string }> = {
  warning: { surface: "bg-tg-warning-soft", icon: "text-tg-warning" },
  destructive: { surface: "bg-tg-destructive-soft", icon: "text-tg-destructive" },
  neutral: { surface: "bg-tg-accent", icon: "text-tg-muted" },
};

const ICONS: Record<StatusBannerState["kind"], ReactNode> = {
  reconnecting: <WifiOff aria-hidden className="size-4" />,
  aiError: <TriangleAlert aria-hidden className="size-4" />,
  readonly: <Lock aria-hidden className="size-4" />,
  limit: <GitBranch aria-hidden className="size-4" />,
};

export interface StatusBannerProps {
  /** null: nothing shows, but the live regions stay mounted so the next state is announced. */
  state: StatusBannerState | null;
  /** Retry now (reconnecting, AI error) or review open branches (limit). No button without it. */
  onAction?: () => void;
  actionLabel?: string;
  /** Clock for the countdown; tests pass a fixed one. */
  now?: () => number;
  className?: string;
}

/** Ticks once a second while there is a countdown to show. */
function useNow(state: StatusBannerState | null, clock: () => number): number {
  const [now, setNow] = useState(clock);
  const kind = state?.kind ?? null;
  const nextRetryAt = state && (state.kind === "reconnecting" || state.kind === "aiError") ? (state.nextRetryAt ?? null) : null;
  const counting = state !== null && (bannerCountdown(state, now) ?? 0) > 0;
  useEffect(() => {
    setNow(clock());
    if (!counting) return undefined;
    const timer = setInterval(() => setNow(clock()), TICK_MS);
    return () => clearInterval(timer);
  }, [kind, nextRetryAt, clock, counting]);
  return now;
}

/**
 * The full-width bar above the messages for A14's global states: reconnecting,
 * AI error with a retry countdown, read-only, and the branch limit.
 *
 * Screen readers: two live regions stay mounted whatever the state (a region
 * created together with its text is often not announced). The stable sentence
 * goes into the polite one, or into the assertive (role=alert) one for an AI
 * error; the ticking countdown on screen is hidden from them.
 */
export function StatusBanner({ state, onAction, actionLabel, now: clock = Date.now, className }: StatusBannerProps) {
  const t = useUiT();
  const now = useNow(state, clock);
  const live = state ? bannerMessage(state, now, t, true) : "";
  const urgent = state?.kind === "aiError";
  return (
    <>
      <div role="status" className="sr-only">
        {urgent ? "" : live}
      </div>
      <div role="alert" className="sr-only">
        {urgent ? live : ""}
      </div>
      {state && <Bar state={state} now={now} onAction={onAction} actionLabel={actionLabel} className={className} />}
    </>
  );
}

function Bar({ state, now, onAction, actionLabel, className }: { state: StatusBannerState; now: number; onAction?: (() => void) | undefined; actionLabel?: string | undefined; className?: string | undefined }) {
  const t = useUiT();
  const tone = TONES[bannerTone(state)];
  const label = actionLabel ?? bannerActionLabel(state, t);
  return (
    <div
      data-tg-banner={state.kind}
      className={cx("flex flex-wrap items-center gap-2.5 border-b border-tg-border px-4 py-2.5 text-tg-sm text-tg-foreground", tone.surface, className)}
    >
      <span className={cx("flex shrink-0", tone.icon)}>{ICONS[state.kind]}</span>
      <span aria-hidden className="min-w-0 flex-[1_1_15rem]">
        {bannerMessage(state, now, t)}
      </span>
      {onAction && label && (
        <Button size="sm" onClick={onAction}>
          {label}
        </Button>
      )}
    </div>
  );
}
