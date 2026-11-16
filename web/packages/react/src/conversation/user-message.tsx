import type { Message } from "@tangent/client";
import { memo, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { isOptimisticMessage } from "../data/message-cache";
import { MessageTime } from "./message-time";
import { PinnedMark } from "./pinned-mark";

export interface UserMessageProps {
  message: Message;
  /** e.g. "你・#16"; the label row above the bubble. */
  label?: string;
  highlighted?: boolean;
  /** Hover / focus actions (MessageActions, floating at the top right). */
  actions?: ReactNode;
  /** Its argument type control (the ibis feature, D2), in the label row. */
  tag?: ReactNode;
  /** The touch screens' 「⋯」 (F8 S1), at the label row's end. */
  menu?: ReactNode;
  className?: string;
}

/**
 * The operator's message (components.md): right-aligned bubble, max 86%,
 * large radius with a small top-right corner, `--tg-accent` fill. The text is
 * shown as typed — no Markdown, line breaks kept.
 */
function UserMessageView({ message, label, highlighted = false, actions, tag, menu, className }: UserMessageProps) {
  const sending = isOptimisticMessage(message);
  return (
    <div data-tg-message={message.id} className={cx("group relative flex max-w-[86%] flex-col items-end gap-1 self-end", className)}>
      {(label || message.pinned || tag || menu) && (
        <span className="flex flex-wrap items-center justify-end gap-2">
          {message.pinned && <PinnedMark />}
          {tag}
          {label && (
            <span className="text-tg-xs text-tg-subtle">
              <span>{label}</span>
              {!sending && <MessageTime at={message.createdAt} />}
            </span>
          )}
          {menu}
        </span>
      )}
      <div
        aria-busy={sending || undefined}
        className={cx(
          "rounded-tg-lg rounded-tr-tg-sm bg-tg-accent px-3.5 py-2.5 text-tg-md leading-[1.6] break-words whitespace-pre-wrap text-tg-foreground",
          highlighted && "outline-2 outline-tg-highlight",
          sending && "opacity-70",
        )}
      >
        {message.content}
      </div>
      {actions}
    </div>
  );
}

export const UserMessage = memo(UserMessageView);
