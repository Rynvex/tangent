import type { Seed } from "@tangent/client";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { cx } from "../lib/cx";
import { useP1T } from "../i18n/p1-messages";

/** Where a seed was parked, as the card shows it; `lineId` null means there is nothing to go to. */
export interface SeedSource {
  label: string;
  lineId: string | null;
  messageId?: string;
}

export interface SeedCardProps {
  seed: Seed;
  source: SeedSource;
  readOnly?: boolean;
  /** The host opens the branch dialog prefilled with the seed. */
  onExpand?: () => void;
  /** F10 §4.2 直接問: the host expands the seed and sends its text in the new branch, no dialog. */
  onAsk?: () => void;
  /** Only while notes are on. */
  onNote?: () => void;
  onDrop?: () => void;
  /** Goes to the source message, or to the branch an expanded seed became. */
  onGoTo?: (lineId: string, messageId?: string) => void;
  /** The action running now, for its button's busy state. */
  pending?: "note" | "drop" | "ask" | null;
  /** Why the last action failed. */
  error?: string | null;
}

export const INBOX_CARD = "flex flex-col gap-1.5 rounded-tg-sm p-2.5";
const LINK =
  "inline-flex items-center gap-0.5 rounded-tg-sm text-left text-tg-xs text-tg-subtle hover:text-tg-primary-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11";

function Source({ source, onGoTo }: { source: SeedSource; onGoTo: SeedCardProps["onGoTo"] }) {
  const t = useP1T();
  const text = t("parking.from", { label: source.label });
  const target = source.lineId;
  if (target === null || !onGoTo) return <span className="min-w-0 flex-1 truncate text-tg-xs text-tg-subtle">{text}</span>;
  return (
    <button type="button" aria-label={t("parking.goSource", { label: source.label })} onClick={() => onGoTo(target, source.messageId)} className={cx(LINK, "min-w-0 flex-1")}>
      <span className="truncate">{text}</span>
    </button>
  );
}

/** What became of a seed that is no longer waiting. */
function Outcome({ seed, onGoTo }: Pick<SeedCardProps, "seed" | "onGoTo">) {
  const t = useP1T();
  if (seed.status === "expanded") {
    return (
      <span className="flex flex-wrap items-center gap-x-2 text-tg-xs text-tg-muted">
        {t("parking.expanded")}
        {seed.expandedLineId && onGoTo && (
          <button type="button" onClick={() => onGoTo(seed.expandedLineId)} className={cx(LINK, "text-tg-primary-text")}>
            {t("parking.openBranch")}
            <ArrowUpRight aria-hidden className="size-3" />
          </button>
        )}
      </span>
    );
  }
  return <span className="text-tg-xs text-tg-muted">{seed.status === "noted" ? t("parking.noted") : t("parking.dropped")}</span>;
}

/**
 * One parked thought (B3; components.md SeedCard p 10, gap 6): its text, where
 * it came from (a link to the message), and while waiting: expand into a
 * branch, save to the notes (only with notes on), drop. Expanded, noted and
 * dropped seeds say what happened; a dropped one is struck through.
 */
export function SeedCard({ seed, source, readOnly = false, onExpand, onAsk, onNote, onDrop, onGoTo, pending = null, error = null }: SeedCardProps) {
  const t = useP1T();
  const open = seed.status === "open";
  const busy = pending !== null;
  return (
    <article aria-label={t("parking.seedLabel", { text: seed.text })} data-status={seed.status} className={cx(INBOX_CARD, "border border-tg-border bg-tg-surface-raised")}>
      <span className={cx("text-tg-sm break-words", open ? "text-tg-foreground" : "text-tg-muted")}>{seed.status === "dropped" ? <s>{seed.text}</s> : seed.text}</span>
      <div className="flex flex-wrap items-center gap-0.5">
        <Source source={source} onGoTo={onGoTo} />
        {open && !readOnly && (
          <>
            {onAsk && (
              <Button size="sm" variant="ghost" className="text-tg-primary-text" aria-label={t("parking.askLabel", { text: seed.text })} loading={pending === "ask"} disabled={busy && pending !== "ask"} onClick={onAsk}>
                {t("parking.ask")}
              </Button>
            )}
            {onExpand && (
              <Button size="sm" variant="ghost" className="text-tg-primary-text" disabled={busy} onClick={onExpand}>
                {t("parking.expand")}
              </Button>
            )}
            {onNote && (
              <Button size="sm" variant="ghost" loading={pending === "note"} disabled={busy && pending !== "note"} onClick={onNote}>
                {t("parking.note")}
              </Button>
            )}
            {onDrop && (
              <IconButton
                size="sm"
                label={t("parking.dropLabel", { text: seed.text })}
                icon={<Trash2 aria-hidden />}
                className="text-tg-subtle"
                aria-busy={pending === "drop" || undefined}
                disabled={busy}
                onClick={onDrop}
              />
            )}
          </>
        )}
      </div>
      {!open && <Outcome seed={seed} onGoTo={onGoTo} />}
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
