import { BRANCH_PURPOSE_MAX, OUTLINE_MAIN_KEY, branchTitle, canDeleteBranch, canRenameBranch, outlineItems, validatePurpose, type BranchView, type Chapter, type OutlineItem } from "@tangent/client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/button";
import { INPUT_SURFACE } from "../components/text-field";
import { cx } from "../lib/cx";
import { useOutlineGroupsT } from "../i18n/outline-groups-messages";
import { useUiT } from "../provider";
import { OutlineStages, hasStages } from "./chapter-stages";
import { OutlineEndedRow, endedRowLabel } from "./outline-ended-row";
import { OutlineRow } from "./outline-row";
import { useOutlineKeys } from "./use-outline-keys";

export interface OutlineTreeProps {
  /** The tree's outline with asides (`useBranches(root, true)`). */
  branches: readonly BranchView[];
  rootLineId: string;
  /** The line on screen (the root id on the main line). */
  currentLineId: string;
  /** Messages on the main line, for its row. */
  mainCount?: number;
  /** Hides renaming (read-only identity). */
  readOnly?: boolean;
  /** Enter / Space / click: switch to that line (the root id for the main line); focus stays in the outline. */
  onEnter: (lineId: string) => void;
  /** Esc with nothing else to undo: the host moves focus back to the composer. */
  onEscape?: () => void;
  /** F2 renames an open branch; without it F2 does nothing (no route yet, see the F2 devlog). */
  onRename?: (lineId: string, purpose: string) => Promise<unknown>;
  /** Shows each ended branch's leaf as its last line (the leaf feature, B1). */
  showLeaves?: boolean;
  /** Shows the argument type each branch forks from (the ibis feature, D2). */
  showTags?: boolean;
  /** F8 S12: branches whose premise changed (their round mark). */
  staleIds?: ReadonlySet<string>;
  /** The selection's actions in the bar (C2: 建立群組 / 合併); `done` ends the selection. */
  selectionActions?: (selected: readonly BranchView[], done: () => void) => ReactNode;
  /** G while selecting: the host runs the action the selection allows. */
  onSelectionKey?: (selected: readonly BranchView[], done: () => void) => void;
  /** F11 §3: the main line's chapters (the chapters feature); from two on a strip of its stages sits above the tree. */
  chapters?: readonly Chapter[];
  /** A stage goes to its chapter's first message on the main line. */
  onGoToChapter?: (chapter: Chapter) => void;
  /**
   * F18 刪除支線: a row's button and Delete on it, for a branch that can be deleted on its own (an ended aside, a
   * discarded branch). The host asks first or offers an undo. Never offered to a read-only identity.
   */
  onDelete?: (branch: BranchView) => void;
  className?: string;
}

function RenameField({ initial, onSave, onCancel }: { initial: string; onSave: (value: string) => Promise<unknown>; onCancel: () => void }) {
  const t = useUiT();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (validatePurpose(value) === "required") {
      setError(t("outline.renameRequired"));
      return;
    }
    onSave(value.trim()).catch((failure: unknown) => setError(t("outline.renameFailed", { reason: failure instanceof Error ? failure.message : "" })));
  };
  return (
    <span className="flex min-w-0 flex-col gap-0.5" onClick={(event) => event.stopPropagation()}>
      <input
        ref={input}
        aria-label={t("outline.renameLabel")}
        aria-invalid={error ? true : undefined}
        maxLength={BRANCH_PURPOSE_MAX}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        className={cx(INPUT_SURFACE, "h-7 px-2")}
      />
      {error && <span className="text-tg-xs text-tg-destructive">{error}</span>}
    </span>
  );
}

/**
 * The branch outline (A8; interactions.md): a `role="tree"` with one tab
 * stop (roving tabindex) that starts on "you are here". Arrows, Home / End,
 * → / ←, Enter / Space, `*`, typeahead, Shift+arrows and ⌘A for several
 * (only when the host gives selection actions: C2's group and combine), G
 * to act on them, F2 to rename, Esc back to the composer.
 */
export function OutlineTree({ branches, rootLineId, currentLineId, mainCount, readOnly = false, onEnter, onEscape, onRename, showLeaves = false, showTags = false, staleIds, selectionActions, onSelectionKey, chapters, onGoToChapter, onDelete, className }: OutlineTreeProps) {
  const t = useUiT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  // F11 §1: asides (順口問, also what 秒問解釋 makes) show as leaves by default; the toggle under the tree hides them.
  const [showAsides, setShowAsides] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  // F9 B.4: from six ended children a parent groups them by how they ended; the choice is kept per parent.
  const groupsT = useOutlineGroupsT();
  const [endedShown, setEndedShown] = useState<ReadonlySet<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  // The group holding the line on screen opens by itself, until the reader closes it.
  const [dismissedReveal, setDismissedReveal] = useState<string | null>(null);
  useEffect(() => setDismissedReveal(null), [currentLineId]);
  const reveal = currentLineId === rootLineId || dismissedReveal === currentLineId ? null : currentLineId;
  const items = useMemo(() => outlineItems(branches, { collapsed, showAsides, endedShown, openGroups, reveal }), [branches, collapsed, showAsides, endedShown, openGroups, reveal]);
  const itemOf = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);
  const purposeOf = useMemo(() => new Map(branches.map((branch) => [branch.lineId, branch.purpose])), [branches]);
  const currentKey = currentLineId === rootLineId ? OUTLINE_MAIN_KEY : currentLineId;
  const [focusedKey, setFocusedKey] = useState(currentKey);
  const focused = items.some((item) => item.key === focusedKey) ? focusedKey : items.some((item) => item.key === currentKey) ? currentKey : OUTLINE_MAIN_KEY;
  const rows = useRef(new Map<string, HTMLDivElement>());
  const hasFocus = useRef(false);
  const asides = branches.filter((branch) => branch.kind === "aside").length;
  const byKey = useMemo(() => new Map(branches.map((branch) => [branch.lineId, branch])), [branches]);
  const label = (key: string) => {
    const row = itemOf.get(key);
    if (row?.group || row?.toggle) return endedRowLabel(row, groupsT);
    const branch = byKey.get(key);
    return branch ? branchTitle(branch, t) : t("breadcrumb.main");
  };
  const lineOf = (key: string) => (key === OUTLINE_MAIN_KEY ? rootLineId : key);
  // B13: ended branches can be renamed too (not a promoted one, not the previous main line).
  const canRename = (key: string) => {
    const branch = byKey.get(key);
    return !readOnly && onRename !== undefined && branch !== undefined && canRenameBranch(branch);
  };
  const deletable = (branch: BranchView | null | undefined): branch is BranchView => !readOnly && onDelete !== undefined && branch != null && canDeleteBranch(branch);
  // Multi-select only means something with an action to take (group on, a writer): R9 G2.
  const canSelect = selectionActions !== undefined;
  const branchesOf = (keys: ReadonlySet<string>) => [...keys].flatMap((key) => byKey.get(key) ?? []);

  const setGroupOpen = (row: OutlineItem, open: boolean) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (open) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
    if (!open && row.group?.revealed) setDismissedReveal(currentLineId);
  };
  const toggleEnded = (parentKey: string) =>
    setEndedShown((current) => {
      const next = new Set(current);
      if (next.has(parentKey)) next.delete(parentKey);
      else next.add(parentKey);
      return next;
    });
  /** Enter / Space / click on a group or the toggle; false on a branch row. */
  const activateEnded = (key: string) => {
    const row = itemOf.get(key);
    if (row?.group) setGroupOpen(row, !row.expanded);
    else if (row?.toggle) toggleEnded(row.toggle.parentKey);
    return Boolean(row?.group || row?.toggle);
  };
  const rowRef = (key: string) => (element: HTMLDivElement | null) => {
    if (element) rows.current.set(key, element);
    else rows.current.delete(key);
  };

  const keys = useOutlineKeys({
    items,
    focused,
    setFocused: setFocusedKey,
    setCollapsed,
    label,
    enter: (key) => {
      if (!activateEnded(key)) onEnter(lineOf(key));
    },
    canRename,
    startRename: setRenaming,
    onEscape,
    canSelect,
    onGroupKey: onSelectionKey ? (selected) => onSelectionKey(branchesOf(selected), keys.clearSelection) : undefined,
    onExpand: (key, expanded) => {
      const row = itemOf.get(key);
      if (!row?.group) return false;
      setGroupOpen(row, expanded);
      return true;
    },
  });

  // Navigating elsewhere (breadcrumb, fork marker, shortcut) moves the tab stop to "you are here";
  // while the reader is in the tree, the row they are on stays put.
  const currentShown = items.some((item) => item.key === currentKey);
  useEffect(() => {
    if (!hasFocus.current && currentShown) setFocusedKey(currentKey);
  }, [currentKey, currentShown]);

  // Moving the tab stop moves DOM focus too, but only while focus is in the tree.
  useLayoutEffect(() => {
    if (hasFocus.current && renaming === null) rows.current.get(focused)?.focus();
  }, [focused, renaming]);

  const finishRename = (key: string, focus = true) => {
    setRenaming(null);
    if (focus) rows.current.get(key)?.focus();
  };

  return (
    <div className={cx("flex min-h-0 flex-col", className)}>
      {hasStages(chapters) && onGoToChapter && <OutlineStages chapters={chapters} onGo={onGoToChapter} />}
      <div
        role="tree"
        aria-label={t("outline.label")}
        aria-multiselectable={keys.selected ? true : undefined}
        onKeyDown={(event) => {
          const target = byKey.get(focused);
          // Delete on a branch that can go (not while several are selected, where keys act on the selection).
          if (event.key === "Delete" && !keys.selected && renaming === null && deletable(target)) {
            event.preventDefault();
            onDelete?.(target);
            return;
          }
          keys.onKeyDown(event);
        }}
        onFocus={() => {
          hasFocus.current = true;
        }}
        onBlur={(event) => {
          hasFocus.current = event.currentTarget.contains(event.relatedTarget as Node | null);
        }}
        className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2 pb-2"
      >
        {items.map((item) =>
          item.group || item.toggle ? (
            <OutlineEndedRow
              key={item.key}
              item={item}
              isFocused={item.key === focused}
              t={groupsT}
              rowRef={rowRef(item.key)}
              onFocus={() => setFocusedKey(item.key)}
              onActivate={() => {
                setFocusedKey(item.key);
                activateEnded(item.key);
              }}
            />
          ) : (
            <OutlineRow
              key={item.key}
              item={item}
              mainCount={mainCount}
              showLeaf={showLeaves}
              showTag={showTags}
              stale={item.branch ? (staleIds?.has(item.branch.lineId) ?? false) : false}
              mergedInto={item.branch?.mergedIntoLineId ? purposeOf.get(item.branch.mergedIntoLineId) : undefined}
              mergedIntoGone={Boolean(item.branch?.mergedIntoLineId) && !purposeOf.has(item.branch?.mergedIntoLineId ?? "")}
              onDelete={deletable(item.branch) ? () => onDelete?.(item.branch!) : undefined}
              isCurrent={item.key === currentKey}
              isFocused={item.key === focused}
              selected={keys.selected && item.branch && item.branch.kind !== "aside" ? keys.selected.has(item.key) : keys.selected ? false : undefined}
              rowRef={rowRef(item.key)}
              onFocus={() => setFocusedKey(item.key)}
              onClick={(shift) => {
                setFocusedKey(item.key);
                if ((shift && canSelect) || keys.selected) {
                  if (!keys.selected) keys.startMultiselect(item.key);
                  if (item.branch && item.branch.kind !== "aside") keys.toggle(item.key);
                  return;
                }
                onEnter(lineOf(item.key));
              }}
              onToggle={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(item.key)) next.delete(item.key);
                  else next.add(item.key);
                  return next;
                })
              }
              onLongPress={() => {
                if (!canSelect) return;
                keys.startMultiselect(item.key);
                if (item.branch && item.branch.kind !== "aside") keys.toggle(item.key);
              }}
              renaming={
                renaming === item.key && item.branch ? (
                  <RenameField
                    initial={item.branch.purpose}
                    onCancel={() => finishRename(item.key)}
                    onSave={async (value) => {
                      await onRename?.(item.key, value);
                      finishRename(item.key);
                    }}
                  />
                ) : undefined
              }
            />
          ),
        )}
        {items.length === 1 && branches.length === 0 && <p className="m-0 px-2.5 py-2 text-tg-xs text-tg-muted">{t("outline.empty")}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
        {asides > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setShowAsides(!showAsides)}>
            {t(showAsides ? "outline.hideAsides" : "outline.showAsides", { count: asides })}
          </Button>
        )}
        {keys.selected ? (
          <>
            <span role="status" className="text-tg-xs text-tg-foreground">
              {t("outline.selected", { count: keys.selected.size })}
            </span>
            {selectionActions?.(branchesOf(keys.selected), keys.clearSelection)}
            <Button variant="ghost" size="sm" onClick={keys.clearSelection}>
              {t("outline.clearSelection")}
            </Button>
          </>
        ) : (
          canSelect && (
            <Button variant="ghost" size="sm" onClick={() => keys.startMultiselect(focused)}>
              {t("outline.multiselect")}
            </Button>
          )
        )}
      </div>
    </div>
  );
}
