import { chatNumbers, forkContext, type Message } from "@tangent/client";
import { Eye, X } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../components/icon-button";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../components/popover";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

/** Characters of each message shown in the peek. */
const PEEK_CHARS = 220;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > PEEK_CHARS ? `${chars.slice(0, PEEK_CHARS).join("")}…` : flat;
}

export interface ForkPeekProps {
  /** The parent line's messages. */
  messages: readonly Message[];
  anchorMessageId: string;
  /** "Go to that message": switch to the parent and highlight the fork point. */
  onGo: () => void;
  className?: string;
}

function PeekItem({ message, number, isFork }: { message: Message; number: number | undefined; isFork: boolean }) {
  const t = useUiT();
  const who = message.role === "user" ? t("message.labelUser", { n: number ?? "?" }) : t("message.labelAssistant", { n: number ?? "?" });
  return (
    <div data-tg-peek-fork={isFork ? "" : undefined} className={cx("flex flex-col gap-0.5 rounded-tg-sm px-2 py-1.5", isFork && "bg-tg-highlight")}>
      <span className={cx("text-tg-xs", isFork ? "text-tg-foreground" : "text-tg-subtle")}>{isFork ? t("peek.fork", { label: who }) : who}</span>
      <span className="text-tg-sm text-tg-foreground">{excerpt(message.content)}</span>
    </div>
  );
}

/**
 * The fork-point preview (A4; components.md max-w 560, shadow-overlay, p
 * 10/12): the message the branch hangs on (on `--tg-highlight`) with one
 * message before and after it, without leaving the branch. "Go to that
 * message" switches to the parent line and highlights it.
 */
export function ForkPeek({ messages, anchorMessageId, onGo, className }: ForkPeekProps) {
  const t = useUiT();
  const [open, setOpen] = useState(false);
  const context = forkContext(messages, anchorMessageId);
  const numbers = chatNumbers(messages);
  const number = numbers.get(anchorMessageId);
  const title = number === undefined ? t("peek.gone") : t("peek.title", { n: number });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cx(
          "inline-flex h-5.5 items-center gap-1 rounded-tg-sm border border-tg-border-strong bg-tg-surface px-1.5 text-tg-xs text-tg-foreground hover:bg-tg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11",
          className,
        )}
      >
        <Eye aria-hidden className="size-3" />
        {t("branchBar.peek")}
      </PopoverTrigger>
      <PopoverContent aria-label={title} className="w-[min(35rem,calc(100vw-2rem))] gap-1.5 px-3 py-2.5">
        <div className="flex items-center gap-2 text-tg-xs text-tg-muted">
          <span className="flex-1">{title}</span>
          <PopoverClose render={<IconButton label={t("peek.close")} icon={<X />} size="sm" tooltip={false} />} />
        </div>
        {context.before && <PeekItem message={context.before} number={numbers.get(context.before.id)} isFork={false} />}
        {context.anchor && <PeekItem message={context.anchor} number={number} isFork />}
        {context.after && <PeekItem message={context.after} number={numbers.get(context.after.id)} isFork={false} />}
        {context.anchor && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onGo();
            }}
            className="h-6.5 self-start rounded-tg-sm px-2 text-tg-xs text-tg-primary-text hover:bg-tg-primary-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11"
          >
            {t("peek.go")}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
