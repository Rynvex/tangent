import type { Flashcard } from "@tangent/client";
import { Badge } from "../components/display";
import { useExportT } from "../i18n/export-messages";
import { cx } from "../lib/cx";
import { SOURCE_KEYS } from "./export-labels";

export type ExportPreviewProps =
  /** A file's text, exactly as it is downloaded. */
  | { mode: "text"; text: string; className?: string }
  /** Flashcards: front and back with where each came from. */
  | { mode: "cards"; cards: readonly Flashcard[]; className?: string };

const REGION = "min-h-0 overflow-auto rounded-tg-sm border border-tg-border bg-tg-surface-sunken px-4 py-3.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring";

/**
 * The export dialog's preview (F8 S9, components `ExportPreview`): the text
 * to download in 12px monospace at line height 1.6, or the flashcards as
 * front / back cards. A focusable scroll region, so the keyboard can scroll it.
 */
export function ExportPreview(props: ExportPreviewProps) {
  const t = useExportT();
  if (props.mode === "text") {
    return (
      <pre tabIndex={0} aria-label={t("export.preview")} className={cx(REGION, "m-0 font-tg-mono text-[0.75rem] leading-[1.6] break-words whitespace-pre-wrap text-tg-foreground", props.className)}>
        {props.text}
      </pre>
    );
  }
  return (
    <ol tabIndex={0} aria-label={t("export.preview")} className={cx(REGION, "m-0 flex list-none flex-col gap-2.5", props.className)}>
      {props.cards.map((card, index) => (
        <li key={`${card.lineId}:${card.messageId ?? ""}:${index}`} className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-border bg-tg-surface-raised p-3">
          <span className="flex items-center gap-2 text-tg-xs text-tg-muted">
            <span className="font-tg-mono tabular-nums">{index + 1}</span>
            <Badge>{t(SOURCE_KEYS[card.source])}</Badge>
          </span>
          <span className="text-tg-xs font-medium text-tg-subtle">{t("exportDoc.front")}</span>
          <p className="m-0 text-tg-sm break-words whitespace-pre-wrap text-tg-foreground-strong">{card.front}</p>
          <span className="border-t border-tg-border pt-1.5 text-tg-xs font-medium text-tg-subtle">{t("exportDoc.back")}</span>
          <p className="m-0 text-tg-sm break-words whitespace-pre-wrap text-tg-foreground">{card.back}</p>
        </li>
      ))}
    </ol>
  );
}
