import { TAG_KIND_KEYS, TAG_TEXT } from "../p3/tag-kinds";
import { branchTitle, type BranchStatus, type OutlineItem } from "@tangent/client";
import { BookmarkCheck, Check, ChevronDown, ChevronRight, Combine, Flag, List, Trash2 } from "lucide-react";
import { useId, useRef, type PointerEvent, type ReactNode } from "react";
import { KIND_ICONS } from "../conversation/branch-suggestions";
import { branchStatusKey, isAsideLeaf } from "../conversation/aside-leaf";
import { Leaf } from "../leaf/leaf";
import { LEAF_KIND_KEYS } from "../leaf/leaf-meta";
import { StaleMark } from "../f8/stale-badge";
import { useF8T } from "../i18n/f8-messages";
import { cx } from "../lib/cx";
import { useP1T } from "../i18n/p1-messages";

const STATUS_TEXT: Record<BranchStatus, string> = {
  open: "text-tg-branch-open",
  merged: "text-tg-branch-merged",
  discarded: "text-tg-branch-discarded",
  promoted: "text-tg-branch-promoted",
};

/** components.md OutlineRow: min h 36, 18 per level, p 7/10. */
const INDENT_REM = 1.125;

export interface OutlineRowProps {
  item: OutlineItem;
  mainCount?: number | undefined;
  isCurrent: boolean;
  isFocused: boolean;
  /** Present in multiselect mode. */
  selected?: boolean | undefined;
  /** The inline rename field, while renaming this row. */
  renaming?: ReactNode;
  /** Shows the branch's leaf (the leaf feature is on); off = not rendered. */
  showLeaf?: boolean;
  rowRef: (element: HTMLDivElement | null) => void;
  onClick: (shift: boolean) => void;
  onToggle: () => void;
  onFocus: () => void;
  onLongPress: () => void;
  /** Combined into another branch (B9 phase C): that branch's name. */
  mergedInto?: string | undefined;
  /** Shows the argument type of the message the branch forks from (the ibis feature, D2). */
  showTag?: boolean;
  /** F8 S12: its premise changed (a replaced note, a contradiction); a round mark left of the status. */
  stale?: boolean;
  /** F18: the branch it was combined into is no longer in the outline (deleted, or moved out): said instead of a name. */
  mergedIntoGone?: boolean;
  /** F18 刪除支線: given for a branch that can be deleted (an ended aside, a discarded branch); Delete on the row does the same. */
  onDelete?: (() => void) | undefined;
}

const LONG_PRESS_MS = 500;

/** Touch long-press: multiselect (interactions.md, phones). */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      clear();
      timer.current = setTimeout(onLongPress, LONG_PRESS_MS);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
  };
}

/**
 * One outline row (A8, components.md): kind icon in its status colour,
 * purpose, unread count and status, a branch's one-line conclusion, "you are
 * here". Ended branches without a card stay focusable and enterable, greyed.
 */
export function OutlineRow({ item, mainCount, isCurrent, isFocused, selected, renaming, showLeaf = false, rowRef, onClick, onToggle, onFocus, onLongPress, mergedInto, showTag = false, stale = false, mergedIntoGone = false, onDelete }: OutlineRowProps) {
  const t = useP1T();
  const f8 = useF8T();
  const describedBy = useId();
  const press = useLongPress(onLongPress);
  const branch = item.branch;
  const title = branch ? branchTitle(branch, t) : t("breadcrumb.main");
  const unread = branch && branch.status === "open" ? branch.unread : 0;
  const leaf = showLeaf ? (branch?.leaf ?? null) : null;
  const leafPart = leaf ? [`${t("leaf.kindPrefix", { kind: t(LEAF_KIND_KEYS[leaf.kind]) })}${leaf.line}${leaf.status === "draft" ? ` (${t("leaf.draftBadge")})` : ""}`] : [];
  const anchorTag = showTag ? (branch?.anchorTag ?? null) : null;
  const tagName = anchorTag ? t(TAG_KIND_KEYS[anchorTag.kind]) : "";
  const mergedText = mergedInto ? t("branch.mergedInto", { title: mergedInto }) : mergedIntoGone ? t("branch.mergedIntoGone") : "";
  // B23: a kept aside is not cleared; said next to its status.
  const kept = branch?.kind === "aside" && Boolean(branch.keptAt);
  const parts = branch
    ? [
        title,
        t(branchStatusKey(branch)),
        ...(stale ? [f8("stale.badge")] : []),
        ...(anchorTag ? [t("tag.anchor", { kind: tagName })] : []),
        ...(mergedText ? [mergedText] : []),
        ...(kept ? [t("outline.kept")] : []),
        ...(unread > 0 ? [t("outline.unread", { count: unread })] : []),
        ...leafPart,
      ]
    : [title, t("outline.mainCount", { count: mainCount ?? 0 })];
  const replying = branch?.lineStatus === "thinking";
  // F11 §1: an aside's status says it is a one-turn leaf, and 回答中 while it answers (no extra 回覆中 line).
  const leafRow = isAsideLeaf(branch);
  const muted = branch?.status === "discarded";
  // Multiselect adds a checkbox slot after the fold slot; the detail lines span from the title on.
  const selecting = selected !== undefined;
  const detail = selecting ? "col-start-4 col-end-6" : "col-start-3 col-end-5";
  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-label={parts.join(", ")}
      aria-level={item.level}
      aria-setsize={item.setSize}
      aria-posinset={item.posInSet}
      aria-expanded={item.hasChildren ? item.expanded : undefined}
      aria-current={isCurrent ? "location" : undefined}
      aria-selected={selected}
      aria-describedby={replying && !leafRow ? describedBy : undefined}
      aria-keyshortcuts={onDelete ? "Delete" : undefined}
      tabIndex={isFocused ? 0 : -1}
      onFocus={onFocus}
      onClick={(event) => onClick(event.shiftKey)}
      {...press}
      style={{ paddingInlineStart: `${0.375 + (item.level - 1) * INDENT_REM}rem` }}
      className={cx(
        "group/tg-row grid min-h-9 cursor-pointer items-center gap-x-2 gap-y-0.5 rounded-tg-sm py-1.75 pr-2.5 outline-none select-none pointer-coarse:min-h-11",
        "hover:outline hover:outline-1 hover:outline-tg-border-strong focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-tg-ring",
        selecting ? "grid-cols-[1rem_1rem_1rem_minmax(0,1fr)_auto]" : "grid-cols-[1rem_1rem_minmax(0,1fr)_auto]",
        isCurrent && "bg-tg-primary-soft",
        selected && "bg-tg-accent",
      )}
    >
      <span className="flex">
        {item.hasChildren && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            data-tg-fold=""
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="flex size-4 items-center justify-center rounded-tg-sm text-tg-muted hover:bg-tg-accent"
          >
            {item.expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
      </span>
      {selecting && (
        <span
          aria-hidden
          data-tg-check=""
          data-checked={selected ? "" : undefined}
          className={cx("flex size-3.5 items-center justify-center rounded-[0.25rem] border border-tg-border-input", selected && "border-tg-primary bg-tg-primary text-tg-primary-foreground")}
        >
          {selected && <Check className="size-2.5" strokeWidth={3} />}
        </span>
      )}
      <span aria-hidden className={cx("flex [&_svg]:size-3.5", branch ? STATUS_TEXT[branch.status] : "text-tg-foreground")}>
        {branch ? KIND_ICONS[branch.kind] : <List />}
      </span>
      {renaming ?? <span className={cx("truncate text-tg-sm", branch ? (muted ? "text-tg-muted" : "text-tg-foreground") : "font-semibold text-tg-foreground-strong")}>{title}</span>}
      <span aria-hidden className="flex items-center gap-1.5 text-tg-xs whitespace-nowrap">
        {anchorTag && <span className={cx("rounded-tg-sm border px-1 text-[0.6875rem] leading-4", TAG_TEXT[anchorTag.kind], anchorTag.status === "draft" && "border-dashed")}>{tagName}</span>}
        {stale && <StaleMark />}
        {unread > 0 && <span className="grid h-4.5 min-w-4.5 place-items-center rounded-tg-full bg-tg-primary px-1.25 font-semibold text-tg-primary-foreground">{unread}</span>}
        {branch ? (
          <span data-tg-status="" className={leafRow ? (replying ? "text-tg-status-thinking" : "text-tg-muted") : STATUS_TEXT[branch.status]}>
            {t(branchStatusKey(branch))}
          </span>
        ) : <span className="text-tg-muted">{t("outline.mainCount", { count: mainCount ?? 0 })}</span>}
        {kept && <BookmarkCheck data-tg-kept="" className="size-3 text-tg-muted" />}
        {onDelete && !selecting && (
          // Pointer only (the row is one tree item): the keyboard's way is Delete on the row.
          <button
            type="button"
            tabIndex={-1}
            data-tg-delete=""
            title={t("outline.delete", { title })}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            className="-my-1 flex size-6 items-center justify-center rounded-tg-sm text-tg-muted opacity-0 group-hover/tg-row:opacity-100 group-focus-visible/tg-row:opacity-100 hover:bg-tg-accent hover:text-tg-destructive pointer-coarse:size-9 pointer-coarse:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </span>
      {leaf && (
        <span aria-hidden className={cx(detail, "flex min-w-0")}>
          <Leaf leaf={leaf} />
        </span>
      )}
      {!leaf && branch?.conclusionLine && (
        <span aria-hidden className={cx(detail, "flex min-w-0 items-center gap-1 text-tg-xs text-tg-muted")}>
          <Flag className="size-3 shrink-0" />
          <span className="truncate">{branch.conclusionLine}</span>
        </span>
      )}
      {mergedText && (
        <span aria-hidden data-tg-merged-into={mergedInto ? "" : "gone"} className={cx(detail, "flex min-w-0 items-center gap-1 text-tg-xs text-tg-muted")}>
          <Combine className="size-3 shrink-0" />
          <span className="truncate">{mergedText}</span>
        </span>
      )}
      {isCurrent && <span className={cx(detail, "text-tg-xs font-semibold text-tg-primary-text")}>{t("outline.here")}</span>}
      {replying && !leafRow && (
        <span id={describedBy} className={cx(detail, "text-tg-xs text-tg-status-thinking")}>
          {t("outline.replying")}
        </span>
      )}
    </div>
  );
}
