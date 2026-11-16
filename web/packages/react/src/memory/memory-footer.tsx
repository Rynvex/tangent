import { isFeatureOn } from "@tangent/client";
import { Layers } from "lucide-react";
import { useId } from "react";
import { useCapabilities, usePreview } from "../data/queries";
import { useMemoryT } from "../i18n/memory-messages";
import { cx } from "../lib/cx";
import { MemoryItem } from "./memory-item";

export interface MemoryFooterProps {
  /** The line on screen: what its next turn recalls. */
  lineId: string;
  /** 記憶庫: the host's page of every memory. */
  onOpenLibrary?: () => void;
  className?: string;
}

/**
 * 跨對話記憶 under the notes (D1; components.md `MemoryFooter`: dashed box,
 * p 10/12; brought in, none): what the line's next turn brings in from
 * earlier conversations, set apart from this conversation's notes.
 */
export default function MemoryFooter({ lineId, onOpenLibrary, className }: MemoryFooterProps) {
  const t = useMemoryT();
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "memory");
  // The same query the send preview and the fisheye layer use for an empty draft.
  const preview = usePreview(lineId, "", on);
  const headingId = useId();
  if (!on) return null;
  const recalled = preview.data?.memories ?? [];
  return (
    <section aria-labelledby={headingId} className={cx("flex flex-col gap-1.5 rounded-tg border border-dashed border-tg-border-strong bg-tg-surface-sunken px-3 py-2.5", className)}>
      <span className="flex items-center gap-1.5 text-tg-xs">
        <Layers aria-hidden className="size-3.25 text-tg-foreground" />
        <span id={headingId} className="font-semibold text-tg-foreground">
          {t("footer.title")}
        </span>
        <span className="flex-1 text-tg-subtle">{t("footer.notThis")}</span>
        {onOpenLibrary && (
          <button type="button" onClick={onOpenLibrary} className="text-tg-primary-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
            {t("footer.library")}
          </button>
        )}
      </span>
      {preview.isSuccess && recalled.length === 0 && <p className="m-0 text-tg-xs text-tg-muted">{t("footer.none")}</p>}
      {recalled.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {recalled.map(({ memory }) => (
            <li key={memory.id}>
              <MemoryItem memory={memory} className="text-tg-xs" />
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-[0.6875rem] text-tg-subtle">{t("footer.note")}</p>
    </section>
  );
}

export { MemoryFooter };
