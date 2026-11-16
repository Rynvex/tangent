/**
 * F16.1 BatchActionBar: pinned at the top of S2's list while sessions are
 * checked: 「已選 n 篇」, 取消選取, and what to do with them: 設為章節 §,
 * 掛為支線 ↳ (on the nearest chapter, or the one picked beside it), 另存成
 * 獨立對話, 合併成 1 篇 (two or more). Phones keep it (no dragging there).
 */
import type { NodeRole } from "@tangent/client";
import { ArrowDown, Bookmark, CornerDownRight, ExternalLink, Merge, X } from "lucide-react";
import { useState } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";

export interface BatchChapter {
  key: string;
  chapter: number;
  title: string;
}

export interface BatchTargetNode {
  key: string;
  chapter: number | null;
  role: NodeRole;
  title: string;
}

export interface BatchActionBarProps {
  count: number;
  chapters: readonly BatchChapter[];
  targets?: readonly BatchTargetNode[];
  touch: boolean;
  onRole: (role: NodeRole, chapterKey?: string) => void;
  onMerge: (targetKey?: string) => void;
  onMoveAfter?: (targetKey: string) => void;
  onClear: () => void;
}

export function BatchActionBar({ count, chapters, targets, touch, onRole, onMerge, onMoveAfter, onClear }: BatchActionBarProps) {
  const t = useF14T();
  const [targetKey, setTargetKey] = useState("");
  const candidateList = targets && targets.length > 0 ? targets : chapters.map((c) => ({ key: c.key, chapter: c.chapter, role: "chapter" as NodeRole, title: c.title }));
  const picked = candidateList.some((item) => item.key === targetKey) ? targetKey : "";
  const button = cx(
    "inline-flex shrink-0 items-center gap-1 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-tg-xs font-medium text-tg-foreground hover:border-tg-border-strong hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring disabled:opacity-45",
    touch ? "h-11" : "h-7",
  );
  return (
    <div data-tg-batch-bar="" role="group" aria-label={t("f161.batchBar")} className="sticky top-0 z-20 flex flex-wrap items-center gap-1.5 rounded-tg border border-tg-primary bg-tg-surface px-2 py-1.5 shadow-tg">
      <span role="status" className="text-tg-xs font-semibold text-tg-primary-text">
        {t("f161.selected", { n: count })}
      </span>
      {candidateList.length > 0 && (
        <select
          aria-label={t("f161.batchTargetPick")}
          data-tg-batch-chapter=""
          data-tg-batch-target=""
          value={picked}
          onChange={(event) => setTargetKey(event.target.value)}
          className={cx("max-w-44 min-w-0 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1.5 text-tg-xs text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-11" : "h-7")}
        >
          <option value="">{t("f161.batchTargetAuto")}</option>
          {candidateList.map((item) => (
            <option key={item.key} value={item.key}>
              {item.chapter ? t("f161.chapterOption", { n: item.chapter, title: item.title }) : item.title}
            </option>
          ))}
        </select>
      )}
      <button type="button" onClick={onClear} className={cx(button, "ml-auto border-transparent")}>
        <X aria-hidden className="size-3.5" />
        {t("f161.clearSelection")}
      </button>
      {/* The actions wrap (phones get two or three rows): every one stays visible inside the bar. */}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" data-tg-batch-role="chapter" onClick={() => onRole("chapter")} className={button}>
          <Bookmark aria-hidden className="size-3.5" />
          {t("f161.batchChapter")}
        </button>
        <button type="button" data-tg-batch-role="merged_branch" onClick={() => onRole("merged_branch", picked || undefined)} className={button}>
          <CornerDownRight aria-hidden className="size-3.5" />
          {t("f161.batchBranch")}
        </button>
        <button type="button" data-tg-batch-role="standalone" onClick={() => onRole("standalone")} className={button}>
          <ExternalLink aria-hidden className="size-3.5" />
          {t("f161.batchStandalone")}
        </button>
        <button type="button" data-tg-batch-merge="" disabled={picked ? count < 1 : count < 2} onClick={() => onMerge(picked || undefined)} className={button}>
          <Merge aria-hidden className="size-3.5" />
          {picked ? t("f161.batchMergeTarget") : t("f161.batchMerge")}
        </button>
        {picked && onMoveAfter && (
          <button type="button" data-tg-batch-move="" onClick={() => onMoveAfter(picked)} className={button}>
            <ArrowDown aria-hidden className="size-3.5" />
            {t("f161.batchMoveAfter")}
          </button>
        )}
      </div>
    </div>
  );
}
