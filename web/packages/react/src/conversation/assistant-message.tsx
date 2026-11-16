import type { Message } from "@tangent/client";
import { CircleSlash, RefreshCw, TriangleAlert } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Button } from "../components/button";
import { streamTextAfter, type StreamState } from "../data/live-store";
import { cx } from "../lib/cx";
import { Markdown, type MarkdownMark, type MarkScanner } from "../markdown";
import { useUiT } from "../provider";
import { MessageTime } from "./message-time";
import { PinnedMark } from "./pinned-mark";
import { ReplyStageStatus, StopGenerateButton } from "./reply-stage";
import { useConversationOptions } from "./view-options";

export interface AssistantMessageProps {
  message: Message;
  /** The live text of a pending reply (`useStreamingReply`); null before the first delta. */
  stream?: StreamState | null;
  label?: string;
  highlighted?: boolean;
  /** Retry a failed reply. */
  onRetry?: () => void;
  /** MessageActions, floating at the top right on hover / focus. */
  actions?: ReactNode;
  /** What follows the reply: the fork marker, AI suggestions. */
  footer?: ReactNode;
  /** Its argument type control (the ibis feature, D2), in the label row. */
  tag?: ReactNode;
  /** The touch screens' 「⋯」 (F8 S1), at the label row's end. */
  menu?: ReactNode;
  /** F12 S4: stops a pending reply (the composer's stop, the same action); without it no stop button shows. */
  onStop?: () => void;
  /** The stop is on its way. */
  stopping?: boolean;
  /** F12 S2: the words branches were opened from, marked in the finished text. */
  marks?: readonly MarkdownMark[] | undefined;
  renderMark?: ((mark: MarkdownMark, children: ReactNode) => ReactNode) | undefined;
  /** F19 §2.3: the glossary's terms, found in the finished text's plain runs. */
  scanMarks?: MarkScanner | undefined;
  className?: string;
}

/** S4: a reply stopped before its first word. */
function StoppedEmpty() {
  const t = useUiT();
  return (
    <span className="inline-flex h-7 items-center gap-1.5 self-start rounded-tg-full bg-tg-surface-sunken px-2.5 font-tg-sans text-tg-xs text-tg-muted">
      <CircleSlash aria-hidden className="size-3.5" />
      {t("reply.stopped")}
    </span>
  );
}

function Failed({ reason, onRetry }: { reason: string; onRetry?: (() => void) | undefined }) {
  const t = useUiT();
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-tg-sm bg-tg-destructive-soft px-3 py-2.5 font-tg-sans text-tg-sm text-tg-foreground">
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-tg-destructive" />
      <span className="min-w-0 flex-1">{t("message.failed", { reason: reason || t("message.failedUnknown") })}</span>
      {onRetry && (
        <Button size="sm" icon={<RefreshCw aria-hidden className="size-3" />} onClick={onRetry}>
          {t("message.retry")}
        </Button>
      )}
    </div>
  );
}

/** Gap marker shown before streamed text whose start is lost. */
const GAP = "…";

/**
 * The text of a pending reply: what the server already stored on the message
 * (the base, covering deltas up to `meta.streamSeq`) followed by the streamed
 * text after that seq. Text lost between the two shows a gap marker.
 */
export function pendingText(message: Message, stream: StreamState | null | undefined): string {
  const streamed = streamedAfterBase(message, stream);
  if (!streamed) return message.content;
  if (!hasHole(message, stream)) return `${message.content}${streamed}`;
  return `${message.content}${message.content ? " " : ""}${GAP} ${streamed}`;
}

/**
 * True when text is missing between the stored base and the stream: `/stream`
 * said `truncated` and no streamed delta reaches back into the base (a newer
 * base that covers the stream's start closes the hole).
 */
function hasHole(message: Message, stream: StreamState | null | undefined): boolean {
  if (!stream?.gap) return false;
  const baseSeq = message.meta.streamSeq;
  // Without streamSeq a stored text cannot be placed against the stream; only an empty base is a hole.
  if (baseSeq === undefined) return message.content === "";
  return !stream.deltas.some((delta) => delta.seq <= baseSeq);
}

/**
 * The streamed text not yet included in the stored base: the text after
 * `meta.streamSeq` (a binary search, not a walk over every delta). Without
 * `streamSeq` (a host that stores partial text its own way) the stored text
 * is matched against the stream's start, so it is not repeated.
 */
function streamedAfterBase(message: Message, stream: StreamState | null | undefined): string {
  if (!stream) return "";
  const baseSeq = message.meta.streamSeq;
  if (baseSeq !== undefined) return streamTextAfter(stream, baseSeq);
  const base = message.content;
  if (stream.text.startsWith(base)) return stream.text.slice(base.length);
  return base.startsWith(stream.text) ? "" : stream.text;
}

/**
 * A model reply (components.md): no frame, serif at reading size, Markdown.
 * States: thinking (pending, nothing streamed), streaming, done, stopped
 * (`meta.cancelled`, the partial text stays) and failed (reason + retry).
 */
function AssistantMessageView({ message, stream, label, highlighted = false, onRetry, actions, footer, tag, menu, onStop, stopping = false, marks, renderMark, scanMarks, className }: AssistantMessageProps) {
  const t = useUiT();
  const pending = message.status === "pending";
  // Streaming turned off by the reader: a pending reply shows its stage and the stop, and its words only once it is done.
  const { streamText } = useConversationOptions();
  const text = pending ? (streamText ? pendingText(message, stream) : "") : message.status === "error" ? "" : message.content;
  // Decision #1: before the first word the stage and the stop sit in the label row; once text streams, the stop moves under it.
  const waiting = pending && !text;
  return (
    <article
      data-tg-message={message.id}
      aria-busy={pending || undefined}
      aria-label={label}
      className={cx("group relative flex flex-col gap-1.5 rounded-tg transition-colors duration-(--tg-duration-normal)", highlighted && "bg-tg-highlight", className)}
    >
      {(label || message.pinned || tag || menu || waiting) && (
        <span className="flex flex-wrap items-center gap-2">
          {label && (
            <span className="text-tg-xs text-tg-subtle">
              <span>{label}</span>
              {!pending && <MessageTime at={message.createdAt} />}
            </span>
          )}
          {waiting && <ReplyStageStatus createdAt={message.createdAt} />}
          {waiting && onStop && <StopGenerateButton onStop={onStop} stopping={stopping} />}
          {tag}
          {message.pinned && <PinnedMark />}
          {menu && <span className="ml-auto">{menu}</span>}
        </span>
      )}
      {text && (
        <Markdown variant="message" isStreaming={pending} {...(!pending && renderMark && (marks || scanMarks) ? { renderMark, ...(marks ? { marks } : {}), ...(scanMarks ? { scanMarks } : {}) } : {})} className="font-tg-serif text-tg-reading leading-tg-reading tracking-[0.01em] text-tg-foreground [&_p+p]:mt-3">
          {text}
        </Markdown>
      )}
      {pending && text && <span className="sr-only">{t("message.streaming")}</span>}
      {pending && text && onStop && <StopGenerateButton onStop={onStop} stopping={stopping} />}
      {message.meta.cancelled && !text && <StoppedEmpty />}
      {message.meta.cancelled && text && <span className="font-tg-sans text-tg-xs text-tg-warning">{t("message.stopped")}</span>}
      {message.status === "error" && <Failed reason={message.meta.error ?? ""} onRetry={onRetry} />}
      {actions}
      {footer}
    </article>
  );
}

/** Memoised: a finished reply re-renders only when its message or slots change. */
export const AssistantMessage = memo(AssistantMessageView);
