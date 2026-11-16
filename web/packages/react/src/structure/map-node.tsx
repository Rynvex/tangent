import { TAG_KIND_KEYS, TAG_TEXT } from "../p3/tag-kinds";
import { branchTitle, type BranchStatus, type FisheyeLevel, type MapNode } from "@tangent/client";
import { Check, ChevronLeft, ChevronRight, List, Loader2, NotebookPen } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";
import { KIND_ICONS } from "../conversation/branch-suggestions";
import { STATUS_KEYS } from "../conversation/models";
import { branchStatusKey, isAsideLeaf } from "../conversation/aside-leaf";
import { Leaf } from "../leaf/leaf";
import { cx } from "../lib/cx";
import { useP1T } from "../i18n/p1-messages";
import { useP2T } from "../i18n/p2-messages";
import { useFocusT } from "../i18n/focus-messages";
import { FISHEYE_OPACITY, LEVEL_KEYS } from "../p2/fisheye-levels";

/** Border colour = status (handoff §9-7: each kind of information has its own visual channel). */
const BORDER: Record<BranchStatus, string> = {
  open: "border-tg-branch-open",
  merged: "border-tg-branch-merged",
  discarded: "border-tg-branch-discarded",
  promoted: "border-tg-branch-promoted",
};
const ICON: Record<BranchStatus, string> = {
  open: "text-tg-branch-open",
  merged: "text-tg-branch-merged",
  discarded: "text-tg-branch-discarded",
  promoted: "text-tg-branch-promoted",
};

/** The smallest zoom at which fold toggles are offered (they would crowd the next column below it). */
export const FOLD_MIN_ZOOM = 0.75;

export interface MapNodeViewProps {
  node: MapNode;
  isCurrent: boolean;
  onPath: boolean;
  mainCount: number;
  /** Shows an ended branch's leaf as the node's second line (the leaf feature). */
  showLeaf?: boolean;
  /** The map's zoom: the fold toggle is scaled back so it stays a 24 px target at any zoom (WCAG 2.5.8). */
  zoom: number;
  onEnter: () => void;
  onToggleFold: () => void;
  /** The relation layer (C3): the 8px dot on the right edge starts a drag; absent while the layer is off or for a viewer. */
  onConnectStart?: (event: PointerEvent<HTMLSpanElement>) => void;
  /** Its part in a relation being made: the start, a node it may end on, or the end chosen. */
  linkRole?: "source" | "candidate" | "target" | null;
  /** Combined into another branch (B9 phase C): that branch's name, as the second line. */
  mergedInto?: string | undefined;
  /** The 魚眼 layer (C1): how much of this line AI sees; the frame fades, the level is printed and spoken. */
  fisheyeLevel?: FisheyeLevel | null;
  /** Multi-select (C2): whether it is selected; undefined when the map is not selecting or the node cannot be. */
  selected?: boolean | undefined;
  /** The 論證類型 layer (D2): shows the argument type the branch forks from. */
  showTag?: boolean;
  /**
   * Focus mode (FOCUS_MODE.md §6.2): a click only chooses the node, and this
   * enters its line (double-click, Enter). Absent elsewhere: a click enters.
   */
  onOpen?: (() => void) | undefined;
  /** Focus mode: the node the panel shows (one node; not the multi-select above). */
  chosen?: boolean;
  /** Focus mode: the current line carries a 你在這裡 tag. */
  hereTag?: boolean;
  /** Outside a focused subtree (§6.3): faded, still clickable, and said so. */
  dimmed?: boolean;
  /** Notes from this line (§8.4): a mark at the bottom right with the memos; 0 or absent shows none. */
  noteCount?: number;
  /** Memos written on this line (B13), counted into the same mark. */
  memoCount?: number;
  /** Just appeared (§6.1): fades in once. */
  fresh?: boolean;
  /** Its fork point is in view in the chat (§6.1): a solid highlight glow, never dashed (dashes mean unconfirmed). */
  glow?: boolean;
}

/** One node of the map (components.md 188×60): kind icon, title, conclusion or status, unread; a fold toggle when it has branches. */
export function MapNodeView(props: MapNodeViewProps) {
  const { node, isCurrent, onPath, mainCount, showLeaf = false, zoom, onEnter, onToggleFold, onConnectStart, linkRole = null, fisheyeLevel = null, mergedInto, selected, showTag = false } = props;
  const { onOpen, chosen = false, hereTag = false, dimmed = false, noteCount: notes = 0, memoCount = 0, fresh = false, glow = false } = props;
  // One mark for both kinds; its name says each (§8.4).
  const noteCount = notes + memoCount;
  const t = useP1T();
  const p2 = useP2T();
  const ft = useFocusT();
  // Below this zoom a 24 px toggle would reach the next column's nodes (overlapping targets); zoom in to fold or unfold.
  const canFold = zoom >= FOLD_MIN_ZOOM;
  const branch = node.branch;
  // F11 §1: an aside is a terminal leaf, drawn as one: no relation handle, no fold toggle.
  const leafNode = isAsideLeaf(branch);
  const title = branch ? branchTitle(branch, t) : t("breadcrumb.main");
  const anchorTag = showTag ? (branch?.anchorTag ?? null) : null;
  const tagName = anchorTag ? t(TAG_KIND_KEYS[anchorTag.kind]) : "";
  const base = branch ? t("map.node", { title, status: t(branchStatusKey(branch)) }) : t("map.mainNode", { count: mainCount });
  const tagged = anchorTag ? t("map.nodeTag", { name: base, tag: t("tag.anchor", { kind: tagName }) }) : base;
  // Focus mode marks a line whose reply is being written (S9).
  const replying = hereTag && branch?.lineStatus === "thinking";
  const said = replying ? ft("focus.nodeReplying", { name: tagged }) : tagged;
  const marks =
    memoCount === 0 ? ft("focus.noteCount", { count: notes }) : notes === 0 ? ft("focus.memoCount", { count: memoCount }) : ft("focus.noteMemoCount", { notes, memos: memoCount });
  const name = noteCount > 0 ? ft("focus.nodeNotes", { name: said, notes: marks }) : said;
  const unread = branch && branch.status === "open" ? branch.unread : 0;
  const levelWord = fisheyeLevel ? p2(LEVEL_KEYS[fisheyeLevel]) : "";
  // The frame (surface and border) is its own layer so the 魚眼 layer can fade it without fading the words (contrast).
  const frame = cx(
    "border",
    leafNode ? "rounded-[1.5rem] border-dashed" : "rounded-tg",
    !isCurrent && linkRole !== "candidate" && (leafNode ? "bg-tg-surface-sunken" : "bg-tg-surface"),
    // Outside a focused subtree the status colour steps back too (S8b).
    dimmed ? "border-tg-border" : branch ? BORDER[branch.status] : "border-tg-border-strong",
    onPath && "border-2",
    isCurrent && "bg-tg-primary-soft",
    linkRole === "candidate" && "bg-tg-accent",
  );
  // Focus mode: Enter enters the line (Space, like a click, only chooses it).
  const onKeyDown = onOpen
    ? (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "Enter" || event.repeat) return;
        event.preventDefault();
        onOpen();
      }
    : undefined;
  return (
    <div
      data-tg-map-node={node.key}
      data-on-path={onPath ? "" : undefined}
      data-fisheye-level={fisheyeLevel ?? undefined}
      data-tg-chosen={chosen ? "" : undefined}
      data-tg-dimmed={dimmed ? "" : undefined}
      data-tg-glow={glow ? "" : undefined}
      data-tg-leaf-node={leafNode ? "" : undefined}
      className={cx("group/node absolute", fresh && "motion-safe:animate-[tg-fade-in_600ms_ease-out]")}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
    >
      {fisheyeLevel && <span aria-hidden data-tg-fisheye-frame="" className={cx("absolute inset-0 transition-opacity duration-(--tg-duration-normal)", frame, FISHEYE_OPACITY[fisheyeLevel])} />}
      <button
        type="button"
        aria-label={fisheyeLevel ? p2("fisheye.nodeLevel", { name, level: levelWord }) : name}
        aria-current={isCurrent ? "location" : undefined}
        aria-pressed={selected}
        {...(onOpen ? { "aria-expanded": chosen, onDoubleClick: onOpen, onKeyDown } : {})}
        {...(dimmed ? { "aria-description": ft("focus.outside") } : {})}
        onClick={onEnter}
        className={cx(
          "relative flex size-full flex-col justify-center gap-1 py-1.5 text-left text-tg-foreground hover:shadow-tg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
          leafNode ? "rounded-[1.5rem] px-3.5" : "rounded-tg px-2.5",
          fisheyeLevel ? "border border-transparent" : frame,
          (linkRole === "source" || linkRole === "target" || selected) && "outline-2 outline-offset-2 outline-tg-ring",
          chosen && "ring-2 ring-tg-primary ring-offset-2 ring-offset-tg-surface-sunken",
          // Room for the note mark in the bottom-right corner.
          noteCount > 0 && "pr-7",
          glow && !chosen && "shadow-[0_0_0_4px_var(--tg-highlight)]",
        )}
      >
        {selected && (
          <span aria-hidden className="absolute -top-2 -right-2 grid size-4.5 place-items-center rounded-tg-full bg-tg-primary text-tg-primary-foreground [&_svg]:size-3">
            <Check />
          </span>
        )}
        <span className={cx("flex min-w-0 items-center gap-1.5", dimmed && "opacity-30")}>
          <span aria-hidden className={cx("flex shrink-0 [&_svg]:size-3.25", branch ? ICON[branch.status] : "text-tg-foreground", fisheyeLevel && FISHEYE_OPACITY[fisheyeLevel])}>
            {replying ? <Loader2 data-tg-replying="" className="motion-safe:animate-[tg-spin_1s_linear_infinite]" /> : branch ? KIND_ICONS[branch.kind] : <List />}
          </span>
          <span className={cx("truncate text-tg-xs font-semibold", branch?.status === "discarded" && "text-tg-muted")}>{title}</span>
          {leafNode && (
            <span aria-hidden data-tg-leaf-mark="" className="ml-auto shrink-0 rounded-tg-full border border-dashed border-tg-border-input px-1.5 text-[0.625rem] leading-4 font-medium text-tg-muted">
              {t("branch.asideLeaf")}
            </span>
          )}
          {anchorTag && (
            <span aria-hidden className={cx(!leafNode && "ml-auto", "shrink-0 rounded-tg-sm border bg-tg-surface px-1 text-[0.625rem] leading-4 font-medium", TAG_TEXT[anchorTag.kind], anchorTag.status === "draft" && "border-dashed")}>
              {tagName}
            </span>
          )}
        </span>
        {fisheyeLevel ? (
          <span aria-hidden className={cx("truncate text-[0.6875rem]", fisheyeLevel === "hidden" ? "text-tg-muted" : "text-tg-foreground", dimmed && "opacity-30")}>
            {p2("fisheye.sees", { level: levelWord })}
          </span>
        ) : mergedInto !== undefined ? (
          // "" (F18): the branch it was combined into is no longer in the tree.
          <span className={cx("truncate text-[0.6875rem] text-tg-muted", dimmed && "opacity-30")}>{mergedInto ? t("branch.mergedInto", { title: mergedInto }) : t("branch.mergedIntoGone")}</span>
        ) : showLeaf && branch?.leaf ? (
          // The tree's end nodes carry their leaf (B1); the kind is part of the leaf's own text.
          <span aria-hidden className={cx("flex min-w-0", dimmed && "opacity-30")}>
            <Leaf leaf={branch.leaf} className="text-[0.6875rem]" />
          </span>
        ) : (
          <span aria-hidden className={cx("truncate text-[0.6875rem] text-tg-muted", dimmed && "opacity-30")}>
            {branch ? branch.conclusionLine || t(leafNode ? "branch.asideLeafNote" : STATUS_KEYS[branch.status]) : t("outline.mainCount", { count: mainCount })}
          </span>
        )}
      </button>
      {hereTag && isCurrent && (
        // Stays fully lit while the node is faded (S8b): it says where the chat is.
        <span aria-hidden className="absolute -top-2.5 left-2 rounded-tg-full bg-tg-primary px-1.5 text-[0.625rem] leading-4 font-semibold text-tg-primary-foreground">
          {ft("focus.here")}
        </span>
      )}
      {noteCount > 0 &&
        (canFold ? (
          <span aria-hidden data-tg-note-count="" className={cx("absolute right-1.5 bottom-1 flex items-center gap-0.5 text-[0.625rem] text-tg-muted", dimmed && "opacity-30")}>
            <NotebookPen className="size-2.5" />
            {noteCount}
          </span>
        ) : (
          <span aria-hidden data-tg-note-count="" className={cx("absolute right-1.5 bottom-1.5 size-1.5 rounded-tg-full bg-tg-muted", dimmed && "opacity-30")} />
        ))}
      {onConnectStart && !leafNode && (
        // The drag handle only (interactions.md: R on a node does the same from the keyboard).
        <span
          aria-hidden
          data-tg-connector={node.key}
          onPointerDown={onConnectStart}
          className="absolute top-1/2 -right-1 z-10 size-2 -translate-y-1/2 cursor-crosshair rounded-tg-full border border-tg-surface bg-tg-primary opacity-0 transition-opacity duration-(--tg-duration-fast) group-hover/node:opacity-100 group-focus-within/node:opacity-100 pointer-coarse:size-4 pointer-coarse:opacity-100"
        />
      )}
      {unread > 0 && (
        <span aria-hidden className="absolute -top-2 -left-2 grid h-4.5 min-w-4.5 place-items-center rounded-tg-full bg-tg-primary px-1.25 text-[0.6875rem] font-semibold text-tg-primary-foreground">
          {unread}
        </span>
      )}
      {node.hasChildren && !leafNode && !canFold && node.collapsed && (
        <span aria-hidden className="absolute top-1/2 left-[calc(100%+0.375rem)] -translate-y-1/2 text-[0.6875rem] text-tg-muted">
          +{node.hiddenCount}
        </span>
      )}
      {node.hasChildren && !leafNode && canFold && (
        <button
          type="button"
          aria-label={node.collapsed ? t("map.expand", { count: node.hiddenCount, title }) : t("map.collapse", { title })}
          onClick={onToggleFold}
          style={{ transform: `translateY(-50%) scale(${1 / zoom})`, transformOrigin: "left center" }}
          className="absolute top-1/2 left-[calc(100%+0.375rem)] flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-tg-full border border-tg-border-strong bg-tg-surface-raised px-1 text-[0.6875rem] text-tg-muted hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
        >
          {node.collapsed ? (
            <>
              <span>+{node.hiddenCount}</span>
              <ChevronRight aria-hidden className="size-3" />
            </>
          ) : (
            <ChevronLeft aria-hidden className="size-3" />
          )}
        </button>
      )}
    </div>
  );
}
