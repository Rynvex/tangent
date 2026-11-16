import { chapterTitle, shortDateUnlessToday, type Chapter } from "@tangent/client";
import { ArrowRight } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { cx } from "../lib/cx";
import { useUiLocale, useUiT } from "../provider";

export interface ChapterStripProps {
  chapters: readonly Chapter[];
  /** The transcript's scroll box: the strip follows which chapter is on screen and scrolls to one. */
  scroller: () => HTMLElement | null;
  className?: string;
}

/** The chapter whose divider is the last one at or above the top of the scroll box. */
function currentChapter(box: HTMLElement, chapters: readonly Chapter[]): number {
  const top = box.getBoundingClientRect().top + 24;
  let current = chapters[0]?.index ?? 0;
  for (const chapter of chapters) {
    const divider = box.querySelector(`[data-tg-chapter="${chapter.index}"]`);
    if (divider && divider.getBoundingClientRect().top <= top) current = chapter.index;
  }
  return current;
}

/**
 * F14 S4 ChapterStrip: the main line's chapters as a row of capsules above
 * the transcript, "§1 PG 連線池設定 08/12 → §2 …" (the date only for a
 * chapter that started on another day, as an imported history does; one
 * titled by its time carries the date in its title already). The chapter on
 * screen is highlighted; pressing one scrolls to its divider.
 */
export function ChapterStrip({ chapters, scroller, className }: ChapterStripProps) {
  const t = useUiT();
  const { locale } = useUiLocale();
  const [current, setCurrent] = useState(chapters[0]?.index ?? 0);
  useEffect(() => {
    const box = scroller();
    if (!box) return undefined;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setCurrent(currentChapter(box, chapters)));
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      box.removeEventListener("scroll", update);
    };
  }, [scroller, chapters]);
  const go = (chapter: Chapter) => {
    setCurrent(chapter.index);
    const divider = scroller()?.querySelector<HTMLElement>(`[data-tg-chapter="${chapter.index}"]`);
    divider?.scrollIntoView({ block: "start" });
    // Keyboard and screen reader users land where the chapter starts (the divider takes focus without scrolling again).
    divider?.focus({ preventScroll: true });
  };
  return (
    <nav aria-label={t("chapters.stages")} data-tg-chapter-strip="" className={cx("flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-tg-border px-4 py-1.5 sm:px-8", className)}>
      {chapters.map((chapter, i) => {
        const on = chapter.index === current;
        // A chapter titled by its time (an idle or start chapter) already shows its date (F14.1: no "17:35 08/12").
        const date = chapter.titleSource === "time" || chapter.title === "" ? "" : shortDateUnlessToday(chapter.startAt);
        return (
          <Fragment key={`${chapter.index}-${chapter.startMessageId}`}>
            {i > 0 && <ArrowRight aria-hidden className="size-3 shrink-0 text-tg-subtle" />}
            <button
              type="button"
              aria-label={[t("chapters.stage", { n: chapter.index + 1, title: chapterTitle(chapter, locale) }), date].filter(Boolean).join(" ")}
              aria-current={on ? "location" : undefined}
              onClick={() => go(chapter)}
              className={cx(
                "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-tg-full border px-2.5 text-tg-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-9",
                on ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border bg-tg-surface text-tg-foreground hover:bg-tg-accent",
              )}
            >
              <span className="font-semibold">§{chapter.index + 1}</span>
              <span className="max-w-48 truncate">{chapterTitle(chapter, locale)}</span>
              {date && <span className="font-tg-mono text-tg-muted">{date}</span>}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}
