import { MIN_STAGE_CHAPTERS, chapterStageBoxes, chapterTitle, type Chapter, type PlacedNode } from "@tangent/client";
import { useUiLocale, useUiT } from "../provider";

/** F11 §3: the main line's chapters are shown as stages from two on (one chapter is the whole main line). */
export const hasStages = (chapters: readonly Chapter[] | undefined): chapters is readonly Chapter[] => (chapters?.length ?? 0) >= MIN_STAGE_CHAPTERS;

const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring";

/** "§2 硬體選擇" (the time when it has no name) and the button's name, which starts with it. */
function useStageText() {
  const t = useUiT();
  const { locale } = useUiLocale();
  return (chapter: Chapter, branches = 0) => {
    const label = t("chapters.stage", { n: chapter.index + 1, title: chapterTitle(chapter, locale) });
    const count = chapter.messageCount;
    return { label, name: branches > 0 ? t("chapters.stageGoBranches", { label, count, branches }) : t("chapters.stageGo", { label, count }) };
  };
}

export interface MapStagesProps {
  chapters: readonly Chapter[];
  /** The main node, which the stages hang under. */
  main: PlacedNode;
  /** Whether a branch is drawn on the map (only those are counted on a stage). */
  inMap: (lineId: string) => boolean;
  onGo: (chapter: Chapter) => void;
}

/** The main line's stages on the map (F11 §3): a trunk down from the main node, one node per chapter, with its branches counted. */
export function MapStages({ chapters, main, inMap, onGo }: MapStagesProps) {
  const t = useUiT();
  const text = useStageText();
  const { boxes, bottom } = chapterStageBoxes(main, chapters.length);
  const last = boxes.at(-1);
  const trunkX = main.x + main.width / 2;
  return (
    <>
      {last && (
        <svg aria-hidden width={main.x + main.width} height={bottom} className="pointer-events-none absolute inset-0 overflow-visible">
          <path d={`M ${trunkX} ${main.y + main.height} L ${trunkX} ${last.y + last.height / 2}`} fill="none" strokeWidth={1.25} className="stroke-tg-border-strong" />
        </svg>
      )}
      <div role="list" aria-label={t("chapters.stages")} data-tg-map-chapters="">
        {chapters.map((chapter, i) => {
          const box = boxes[i]!;
          const branches = chapter.branchIds.filter(inMap).length;
          const { label, name } = text(chapter, branches);
          return (
            <div key={`${chapter.index}-${chapter.startMessageId}`} role="listitem" data-tg-map-chapter={chapter.index} className="absolute" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
              <button
                type="button"
                aria-label={name}
                title={label}
                onClick={() => onGo(chapter)}
                className={`flex size-full flex-col justify-center gap-0.5 rounded-tg-sm border border-tg-border bg-tg-surface-raised px-2.5 text-left text-tg-xs shadow-tg hover:bg-tg-accent ${FOCUS_RING}`}
              >
                <span className="truncate font-medium text-tg-foreground">{label}</span>
                <span className="flex items-center gap-2 text-tg-muted">
                  <span>{t("outline.mainCount", { count: chapter.messageCount })}</span>
                  {branches > 0 && (
                    <span data-tg-chapter-branches="" className="rounded-tg-full bg-tg-surface-sunken px-1.5 text-tg-muted">
                      {t("chapters.stageBranches", { count: branches })}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** The outline's strip of main line stages (F11 §3), outside the tree so arrow keys stay the tree's: Tab reaches each. */
export function OutlineStages({ chapters, onGo }: { chapters: readonly Chapter[]; onGo: (chapter: Chapter) => void }) {
  const t = useUiT();
  const text = useStageText();
  return (
    <div role="group" aria-label={t("chapters.stages")} data-tg-outline-chapters="" className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
      {chapters.map((chapter, i) => {
        const { label, name } = text(chapter);
        return (
          <span key={`${chapter.index}-${chapter.startMessageId}`} className="inline-flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="text-tg-xs text-tg-muted">
                →
              </span>
            )}
            <button
              type="button"
              aria-label={name}
              title={label}
              onClick={() => onGo(chapter)}
              className={`inline-flex h-6 max-w-44 items-center rounded-tg-full border border-tg-border px-2 text-tg-xs text-tg-muted hover:bg-tg-accent hover:text-tg-foreground pointer-coarse:h-11 ${FOCUS_RING}`}
            >
              <span className="truncate">{label}</span>
            </button>
          </span>
        );
      })}
    </div>
  );
}
