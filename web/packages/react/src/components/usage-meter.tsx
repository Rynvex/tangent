import type { Usage } from "@tangent/client";
import { ChevronDown, Gauge, TriangleAlert } from "lucide-react";
import { forwardRef, lazy, useCallback, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { LazyRegion } from "./lazy-region";

/** The hint loads the first time the meter is pointed at or focused (like IconButton's; keeps Base UI's tooltip out of the main bundle). */
const TooltipHint = lazy(() => import("./tooltip-hint"));

const THOUSAND = 1000;
const ONE_DECIMAL_BELOW = 10_000;

/** 950 → "950", 1 234 → "1.2k", 38 300 → "38k". */
export function formatTokens(tokens: number): string {
  if (tokens < THOUSAND) return String(Math.round(tokens));
  if (tokens < ONE_DECIMAL_BELOW) return `${(tokens / THOUSAND).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(tokens / THOUSAND)}k`;
}

/** F12 S7: how full the next turn's context is — 80 % warns, 95 % is at the limit. */
export type UsageLevel = "normal" | "warning" | "danger";
export const USAGE_WARNING_SHARE = 0.8;
export const USAGE_DANGER_SHARE = 0.95;

/** The level of a next turn that sends `tokens` of a `budget` (none without a budget). */
export function usageLevel(tokens: number, budget: number): UsageLevel {
  if (!(budget > 0)) return "normal";
  const share = tokens / budget;
  return share >= USAGE_DANGER_SHARE ? "danger" : share >= USAGE_WARNING_SHARE ? "warning" : "normal";
}

export interface UsageMeterProps {
  /** `LineView.usage` (cumulative for the line; PROVISIONAL until C1). */
  usage: Usage;
  /** Opens the context breakdown (F12; A11's send preview before); without it the meter is plain text. */
  onClick?: () => void;
  /** F12 S7: the breakdown it opens is showing (aria-pressed, primary edge). */
  pressed?: boolean;
  /** F12 S7: the next turn's share of the budget (warning edge from 80 %, destructive from 95 %). */
  level?: UsageLevel;
  /** F12 S7: the hover / focus hint (查看上下文組成與 Token 明細（⌘⇧P）). */
  tooltip?: string;
  /** The button's own pointer press (the host tells a press that closes its panel from one that opens it). */
  onPointerDown?: () => void;
  className?: string;
}

const LEVEL_CLASSES: Record<UsageLevel, string> = {
  normal: "border-tg-border-strong bg-tg-surface text-tg-foreground hover:bg-tg-accent",
  warning: "border-tg-warning bg-tg-warning-soft text-tg-foreground hover:bg-tg-accent",
  danger: "border-tg-destructive bg-tg-destructive-soft text-tg-foreground hover:bg-tg-accent",
};

/**
 * The token pill of the conversation header (components.md: h28, full radius,
 * x10). Shows tokens only; cost lives in the send preview (handoff §9-6).
 * As a button (F12 S7, h30): a strong edge, Gauge (TriangleAlert near the
 * limit), mono digits and a chevron; pressed while its breakdown is open.
 */
export const UsageMeter = forwardRef<HTMLButtonElement, UsageMeterProps>(function UsageMeter({ usage, onClick, pressed = false, level = "normal", tooltip, onPointerDown, className }, ref) {
  const t = useUiT();
  const own = useRef<HTMLButtonElement | null>(null);
  const [armed, setArmed] = useState(false);
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  const text = t("usage.tokens", { count: formatTokens(usage.inputTokens + usage.outputTokens) });
  if (!onClick) {
    return <span className={cx("inline-flex h-7 shrink-0 items-center rounded-tg-full bg-tg-accent px-2.5 font-tg-mono text-tg-xs whitespace-nowrap text-tg-muted", className)}>{text}</span>;
  }
  const levelText = level === "warning" ? t("usage.level.warning") : level === "danger" ? t("usage.level.danger") : "";
  const Icon = level === "normal" ? Gauge : TriangleAlert;
  return (
    <>
    <button
      ref={setRef}
      type="button"
      onPointerEnter={(event) => {
        if (tooltip && event.pointerType !== "touch") setArmed(true);
      }}
      onPointerDown={onPointerDown}
      onFocus={() => {
        if (tooltip) setArmed(true);
      }}
      data-tg-usage={level}
      aria-pressed={pressed}
      aria-label={[text, levelText, tooltip ?? t("usage.title")].filter(Boolean).join(". ")}
      onClick={onClick}
      className={cx(
        "inline-flex h-7.5 shrink-0 items-center gap-1.5 rounded-tg-full border pr-2 pl-2.5 font-tg-mono text-tg-xs whitespace-nowrap transition-colors duration-(--tg-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11",
        pressed ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : LEVEL_CLASSES[level],
        className,
      )}
    >
      <Icon aria-hidden className={cx("size-3.5 shrink-0", !pressed && level === "warning" && "text-tg-warning", !pressed && level === "danger" && "text-tg-destructive")} />
      <span className="tabular-nums">{text}</span>
      <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" />
    </button>
    {tooltip && armed && (
      <LazyRegion>
        <TooltipHint anchor={own} content={tooltip} side="bottom" />
      </LazyRegion>
    )}
    </>
  );
});
