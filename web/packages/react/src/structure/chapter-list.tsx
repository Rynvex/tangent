import { chapterRange, chapterTitle, chatNumbers, describeChapterError, type Message } from "@tangent/client";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { TextField } from "../components/text-field";
import { CHAPTER_SOURCE_KEYS, chapterNumbers } from "../conversation/chapter-divider";
import { useAddMilestone, useChapters } from "../data/chapter-hooks";
import { useTangent, useUiT } from "../provider";

export interface ChapterListProps {
  rootLineId: string;
  /** The line whose chapters are listed (the one on screen). */
  lineId: string;
  /** That line's messages, for the "#a–b" ranges. */
  messages: readonly Message[];
  /** Where "add a milestone here" puts it (the line's last chat message); no form without it. */
  anchorMessageId: string | null;
  /** Scrolls to and highlights a chapter's first message. */
  onJump: (messageId: string) => void;
  readOnly?: boolean;
}

/**
 * The side panel's chapters (A10): each chapter with its source and range,
 * a jump to its start, and "add a milestone here" (optional name, at most the
 * server's length). Only rendered when the chapters feature is on.
 */
export function ChapterList({ rootLineId, lineId, messages, anchorMessageId, onJump, readOnly = false }: ChapterListProps) {
  const t = useUiT();
  const { locale, hostErrorText } = useTangent();
  const chapters = useChapters(rootLineId, lineId);
  const add = useAddMilestone(rootLineId, lineId);
  const [title, setTitle] = useState("");
  const numbers = useMemo(() => chatNumbers(messages), [messages]);
  const limits = chapters.data?.limits;
  if (chapters.isPending) {
    return (
      <div role="status" aria-label={t("ui.loading")} className="flex flex-col gap-2 p-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  const list = chapters.data?.chapters ?? [];
  const submit = () => {
    // One milestone per press (R7 D1 sweep): a second press while the first is on its way does nothing.
    if (!anchorMessageId || add.isPending) return;
    add.mutate({ messageId: anchorMessageId, ...(title.trim() ? { title: title.trim() } : {}) }, { onSuccess: () => setTitle("") });
  };
  return (
    <div className="flex flex-col gap-2 px-2 pb-3">
      {list.length === 0 && <p className="m-0 px-2.5 py-2 text-tg-xs text-tg-muted">{t("chapters.empty")}</p>}
      <ul aria-label={t("chapters.label")} className="m-0 flex list-none flex-col gap-0.5 p-0">
        {list.map((chapter) => {
          const range = [chapterNumbers(chapter, numbers, t), chapterRange(chapter, locale)].filter(Boolean).join("・");
          return (
            <li key={`${chapter.index}-${chapter.startMessageId}`}>
              <button
                type="button"
                onClick={() => onJump(chapter.startMessageId)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5 rounded-tg-sm px-3 py-2.5 text-left text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
              >
                <span className="truncate font-medium">{chapterTitle(chapter, locale)}</span>
                <span className="text-tg-xs text-tg-subtle">{t(CHAPTER_SOURCE_KEYS[chapter.kind])}</span>
                {range && <span className="col-span-2 font-tg-mono text-tg-xs text-tg-muted">{range}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {!readOnly && anchorMessageId && (
        <div className="flex flex-col gap-2 px-1 pt-1">
          <TextField label={t("chapters.addTitle")} value={title} maxLength={limits?.milestoneMaxLen} onChange={(event) => setTitle(event.target.value)} />
          <Button size="sm" icon={<Plus aria-hidden className="size-3.5" />} loading={add.isPending} onClick={submit} className="self-start border-dashed">
            {t("chapters.add")}
          </Button>
          {add.error && (
            <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
              {describeChapterError(add.error, t, { ...(limits ? { limits } : {}), hostText: hostErrorText })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
