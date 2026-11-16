import { Brain, Send, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import type { MessageKey } from "../i18n";

/** Decision #2: no gaps — under 3 s, 3 s up to (not including) 8 s, and from 8 s on. */
export const REPLY_STAGE_THINKING_MS = 3000;
export const REPLY_STAGE_DEEP_MS = 8000;
const TICK_MS = 1000;

export type ReplyStage = "preparing" | "thinking" | "deepThinking";

/** The stage a reply is in `elapsedMs` after it was sent (before its first word). */
export function replyStage(elapsedMs: number): ReplyStage {
  if (elapsedMs < REPLY_STAGE_THINKING_MS) return "preparing";
  return elapsedMs < REPLY_STAGE_DEEP_MS ? "thinking" : "deepThinking";
}

const STAGE_KEYS: Record<ReplyStage, MessageKey> = { preparing: "reply.preparing", thinking: "reply.thinking", deepThinking: "reply.deepThinking" };

/** The time the reply started: its `createdAt` (the send), unless that reads as later than now (a server clock ahead). */
function startOf(createdAt: string, now: number): number {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && at <= now ? at : now;
}

/** Whole seconds since `createdAt`, ticking once a second while `running`. */
function useElapsed(createdAt: string, running: boolean): number {
  const [start] = useState(() => startOf(createdAt, Date.now()));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return Math.max(0, now - start);
}

export interface ReplyStageStatusProps {
  /** The pending reply's `createdAt`. */
  createdAt: string;
  className?: string;
}

/**
 * S4 ReplyStageStatus (components h28): the stage of a reply before its first
 * word, updated each second — 正在準備上下文並傳送… (Send), AI 思考中（5s）…
 * and AI 深度思考中（14s）… (Brain). Assistive tech hears only a change of
 * stage, not every second. Icons never spin (reduced motion or not).
 */
export function ReplyStageStatus({ createdAt, className }: ReplyStageStatusProps) {
  const t = useUiT();
  const elapsed = useElapsed(createdAt, true);
  const stage = replyStage(elapsed);
  const seconds = Math.floor(elapsed / 1000);
  const text = t(STAGE_KEYS[stage], { s: seconds });
  // Announced once per stage, with the seconds it was reached at.
  const announced = useRef<{ stage: ReplyStage; text: string } | null>(null);
  if (announced.current?.stage !== stage) announced.current = { stage, text };
  const Icon = stage === "preparing" ? Send : Brain;
  return (
    <>
      <span data-tg-reply-stage={stage} aria-hidden className={cx("inline-flex h-7 items-center gap-1.5 rounded-tg-full bg-tg-surface-sunken px-2.5 font-tg-sans text-tg-xs text-tg-muted", className)}>
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="font-tg-sans tabular-nums">{text}</span>
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announced.current.text}
      </span>
    </>
  );
}

export interface StopGenerateButtonProps {
  onStop: () => void;
  /** The cancel request is on its way. */
  stopping?: boolean;
  className?: string;
}

/** S4 StopGenerateButton (h28, touch 36): the same action as the composer's stop. */
export function StopGenerateButton({ onStop, stopping = false, className }: StopGenerateButtonProps) {
  const t = useUiT();
  return (
    <button
      type="button"
      data-tg-stop=""
      onClick={onStop}
      disabled={stopping}
      aria-disabled={stopping || undefined}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 self-start rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.5 font-tg-sans text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring disabled:opacity-45 pointer-coarse:h-9",
        className,
      )}
    >
      <Square aria-hidden className="size-3 shrink-0 fill-current" />
      {stopping ? t("reply.stopping") : t("reply.stop")}
    </button>
  );
}
