import type { TangentEvent } from "@tangent/client";
import { IconButton } from "@tangent/react";
import { CircleAlert, MessageCircleQuestion, MessageSquareText, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useF12ShellT } from "./f12-shell-messages";

/** Decision #4: a toast stays 6 seconds (paused while pointed at or focused). */
export const REPLY_TOAST_MS = 6000;

export interface ReplyToastState {
  /** The newest line that answered (前往查看 goes there). */
  lineId: string;
  title: string;
  /** How many distinct lines answered while it showed (decision #4 merges them). */
  count: number;
  /** Those lines. */
  lineIds: readonly string[];
  failed: boolean;
  aside: boolean;
  /** Bumped on every merge, so the timer starts again. */
  n: number;
}

export interface ReplyToastOptions {
  rootId: string | null;
  /** The line on screen (its own replies never toast). */
  selected: string | null;
  /** Decision #3: focus mode's map marks the line instead. */
  focusOn: boolean;
  /** Asides open in place on screen answer where they are read. */
  inline: ReadonlySet<string>;
  /** A line's name, and whether it is an aside. */
  describe: (lineId: string) => { title: string; aside: boolean };
  /** G2 (Settings → General → In-app notifications): off, no toast is ever raised. Defaults to on. */
  enabled?: boolean;
}

/** The toast's next state when another background line finishes (decision #4: one toast, merged). */
export function mergeReplyToast(current: ReplyToastState | null, next: Omit<ReplyToastState, "count" | "n" | "lineIds">): ReplyToastState {
  if (!current || current.failed || next.failed) return { ...next, count: 1, lineIds: [next.lineId], n: (current?.n ?? 0) + 1 };
  const lineIds = current.lineIds.includes(next.lineId) ? current.lineIds : [...current.lineIds, next.lineId];
  return { ...next, count: lineIds.length, lineIds, n: current.n + 1 };
}

/**
 * S4 BackgroundReplyToast's state: when a reply that started streaming on
 * another line of this tree finishes (or fails), outside focus mode. Only a
 * reply seen pending counts, so a finished message changing later (a tag) is
 * never news.
 */
export function useReplyToast({ rootId, selected, focusOn, inline, describe, enabled = true }: ReplyToastOptions) {
  const [toast, setToast] = useState<ReplyToastState | null>(null);
  const pending = useRef(new Set<string>());
  const latest = useRef({ rootId, selected, focusOn, inline, describe, enabled });
  latest.current = { rootId, selected, focusOn, inline, describe, enabled };
  useEffect(() => {
    setToast(null);
    pending.current.clear();
  }, [rootId]);
  const onEvent = useCallback((event: TangentEvent) => {
    if (event.type !== "message.created" && event.type !== "message.updated") return;
    const message = event.data;
    if (message.role !== "assistant" || message.kind !== "chat") return;
    if (message.status === "pending") {
      pending.current.add(message.id);
      return;
    }
    if (!pending.current.delete(message.id)) return;
    const now = latest.current;
    if (!now.enabled || now.focusOn || !now.rootId || event.rootLineId !== now.rootId || event.lineId === now.selected || now.inline.has(event.lineId) || message.meta.cancelled) return;
    const { title, aside } = now.describe(event.lineId);
    setToast((current) => mergeReplyToast(current, { lineId: event.lineId, title, failed: message.status === "error", aside }));
  }, []);
  const dismiss = useCallback(() => setToast(null), []);
  // Turned off while one shows: it goes at once.
  return { toast: enabled ? toast : null, onEvent, dismiss };
}

export interface BackgroundReplyToastProps {
  toast: ReplyToastState;
  onView: (lineId: string) => void;
  onClose: () => void;
}

/**
 * S4 BackgroundReplyToast (max 520, phones 12px from the edges, above the
 * composer): 「{title}」已回答完畢 or, merged, 「{title}」等 n 條…, with 前往查看
 * and a close button. Leaves after 6 s; pointing at it or focusing inside it
 * holds it. It appears without sliding in.
 */
export function BackgroundReplyToast({ toast, onView, onClose }: BackgroundReplyToastProps) {
  const t = useF12ShellT();
  const [held, setHeld] = useState(false);
  const holdsFocus = useRef(false);
  const holdsPointer = useRef(false);
  useEffect(() => {
    if (held) return undefined;
    const timer = setTimeout(onClose, REPLY_TOAST_MS);
    return () => clearTimeout(timer);
  }, [held, toast.n, onClose]);
  const update = () => setHeld(holdsFocus.current || holdsPointer.current);
  const text = toast.failed
    ? t("toast.replyFailed", { title: toast.title })
    : toast.count > 1
      ? t("toast.replyDoneN", { title: toast.title, n: toast.count, more: toast.count - 1 })
      : t("toast.replyDone", { title: toast.title });
  const Icon = toast.failed ? CircleAlert : toast.aside ? MessageCircleQuestion : MessageSquareText;
  return (
    // The live region around it stays mounted (the frame's), so the text is announced when it appears.
    <div
      data-tg-reply-toast=""
      onPointerEnter={() => {
        holdsPointer.current = true;
        update();
      }}
      onPointerLeave={() => {
        holdsPointer.current = false;
        update();
      }}
      onFocus={() => {
        holdsFocus.current = true;
        update();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        holdsFocus.current = false;
        update();
      }}
      className="pointer-events-auto flex w-full items-center gap-2.5 rounded-tg bg-tg-foreground-strong py-1.5 pr-1.5 pl-3.5 text-tg-sm text-tg-background shadow-tg-overlay sm:w-auto sm:max-w-[32.5rem]"
    >
      <Icon aria-hidden className={toast.failed ? "size-4 shrink-0 text-tg-destructive" : "size-4 shrink-0"} />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button
        type="button"
        onClick={() => {
          onView(toast.lineId);
          onClose();
        }}
        className="h-7 shrink-0 rounded-tg-sm px-2.5 font-medium underline underline-offset-2 hover:bg-tg-background/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-9"
      >
        {t("toast.goView")}
      </button>
      <IconButton label={t("toast.close")} icon={<X />} size="sm" tooltip={false} className="text-tg-background hover:bg-tg-background/10" onClick={onClose} />
    </div>
  );
}
