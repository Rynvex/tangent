import { chapterRange, chapterTitle, type Chapter, type ChapterKind } from "@tangent/client";
import { X } from "lucide-react";
import { IconButton } from "../components/icon-button";
import type { MessageKey } from "../i18n";
import { useTangent, useUiT } from "../provider";

/** Where a chapter came from (UI_DESIGN_BRIEF A10: topic change, a long pause, a manual milestone). */
export const CHAPTER_SOURCE_KEYS: Record<ChapterKind, MessageKey> = {
  start: "chapters.source.start",
  idle: "chapters.source.idle",
  topic: "chapters.source.topic",
  milestone: "chapters.source.milestone",
};

/** "#a–b": the chat numbers of a chapter's first and last message; "" when they are not on screen. */
export function chapterNumbers(chapter: Chapter, numbers: ReadonlyMap<string, number>, t: ReturnType<typeof useUiT>): string {
  const from = numbers.get(chapter.startMessageId);
  const to = numbers.get(chapter.endMessageId);
  if (from === undefined) return "";
  return to === undefined || to === from ? `#${from}` : t("chapters.range", { from, to });
}

export interface ChapterDividerProps {
  chapter: Chapter;
  numbers: ReadonlyMap<string, number>;
  /** A manual milestone can be removed (chapters feature, write access). */
  onDelete?: ((milestoneId: string) => void) | undefined;
}

/** The divider where a chapter starts (A10): title, message range, time range and source. */
export function ChapterDivider({ chapter, numbers, onDelete }: ChapterDividerProps) {
  const t = useUiT();
  const { locale } = useTangent();
  const title = chapterTitle(chapter, locale);
  const meta = [chapterNumbers(chapter, numbers, t), chapterRange(chapter, locale)].filter(Boolean).join("・");
  return (
    <div data-tg-chapter={chapter.index} tabIndex={-1} className="flex items-center gap-3 pt-2 pb-1 font-tg-sans outline-none focus-visible:outline-2 focus-visible:outline-tg-ring">
      <h2 className="m-0 shrink-0 text-tg-sm font-semibold text-tg-foreground-strong">{title}</h2>
      <span aria-hidden className="h-px flex-1 bg-tg-border" />
      <span className="shrink-0 font-tg-mono text-tg-xs text-tg-muted">{meta}</span>
      <span className="shrink-0 text-tg-xs text-tg-muted">{t(CHAPTER_SOURCE_KEYS[chapter.kind])}</span>
      {onDelete && chapter.kind === "milestone" && chapter.milestoneId && (
        <IconButton label={t("chapters.delete", { title })} icon={<X />} size="sm" tooltip={false} onClick={() => onDelete(chapter.milestoneId)} />
      )}
    </div>
  );
}
