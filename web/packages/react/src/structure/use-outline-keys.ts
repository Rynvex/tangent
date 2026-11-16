/**
 * The outline's state machine (interactions.md A8): idle / focused /
 * typeahead / multiselect / renaming, driven by the key table there. Arrow
 * keys and Enter are basic tree behaviour and cannot be turned off by a host.
 */
import { moveOutlineFocus, outlineRange, outlineSelectable, outlineSiblings, outlineTypeahead, type OutlineItem, type OutlineMove } from "@tangent/client";
import { useRef, useState, type KeyboardEvent } from "react";

/** Characters typed within this window add up to one typeahead query. */
export const TYPEAHEAD_MS = 500;

export interface OutlineKeysInput {
  items: readonly OutlineItem[];
  focused: string;
  setFocused: (key: string) => void;
  setCollapsed: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void;
  label: (key: string) => string;
  enter: (key: string) => void;
  /** F2 on this row may rename it. */
  canRename: (key: string) => boolean;
  startRename: (key: string) => void;
  onEscape?: (() => void) | undefined;
  /** Whether the host offers anything to do with a selection; without it there is no multiselect (R9 G2). */
  canSelect?: boolean;
  /** G while selecting (interactions.md multiselect → G: 建立群組). */
  onGroupKey?: ((selected: ReadonlySet<string>) => void) | undefined;
  /** → / ← on a row the host expands itself (F9 B.4's ended groups); true when it did. */
  onExpand?: ((key: string, expanded: boolean) => boolean) | undefined;
}

const MOVES: Readonly<Record<string, OutlineMove>> = { ArrowDown: "next", ArrowUp: "prev", Home: "first", End: "last" };

export function useOutlineKeys(input: OutlineKeysInput) {
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const anchor = useRef<string | null>(null);
  const typed = useRef({ query: "", at: 0 });
  const { items, focused, setFocused, setCollapsed } = input;
  const item = items.find((entry) => entry.key === focused);

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const startMultiselect = (key: string) => {
    if (input.canSelect === false) return;
    anchor.current = key;
    setSelected((current) => current ?? new Set());
  };
  const clearSelection = () => {
    anchor.current = null;
    setSelected(null);
  };
  const extend = (to: string) => {
    const from = anchor.current ?? focused;
    anchor.current = from;
    setSelected(new Set(outlineRange(items, from, to)));
  };

  const setExpanded = (key: string, expanded: boolean) => {
    if (input.onExpand?.(key, expanded)) return;
    setCollapsed((current) => {
      const next = new Set(current);
      if (expanded) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  function arrowSide(key: string): void {
    if (!item) return;
    if (key === "ArrowRight") {
      if (item.hasChildren && !item.expanded) setExpanded(item.key, true);
      else setFocused(moveOutlineFocus(items, focused, "firstChild"));
      return;
    }
    if (item.hasChildren && item.expanded) setExpanded(item.key, false);
    else setFocused(moveOutlineFocus(items, focused, "parent"));
  }

  function typeahead(char: string): void {
    const now = Date.now();
    const query = now - typed.current.at < TYPEAHEAD_MS ? typed.current.query + char : char;
    typed.current = { query, at: now };
    const found = outlineTypeahead(items, query.length > 1 ? (items[items.findIndex((entry) => entry.key === focused) - 1]?.key ?? focused) : focused, query, input.label);
    if (found) setFocused(found);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget && !(event.target instanceof HTMLElement && event.target.getAttribute("role") === "treeitem")) return;
    const mod = event.metaKey || event.ctrlKey;
    const move = MOVES[event.key];
    let handled = true;
    if (move && event.shiftKey && input.canSelect !== false && (move === "next" || move === "prev")) {
      if (!selected) startMultiselect(focused);
      const to = moveOutlineFocus(items, focused, move);
      setFocused(to);
      extend(to);
    } else if (move) setFocused(moveOutlineFocus(items, focused, move));
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") arrowSide(event.key);
    else if (event.key === "Enter") input.enter(focused);
    else if (event.key === " ") {
      if (selected && item?.branch && item.branch.kind !== "aside") toggle(focused);
      else if (!selected) input.enter(focused);
    } else if (event.key === "*") setCollapsed((current) => new Set([...current].filter((key) => !outlineSiblings(items, focused).includes(key))));
    else if (event.key === "F2" && input.canRename(focused)) input.startRename(focused);
    else if (mod && event.key.toLowerCase() === "a" && selected) setSelected(new Set(outlineSelectable(items)));
    else if (selected && input.onGroupKey && !mod && !event.altKey && event.key.toLowerCase() === "g") input.onGroupKey(selected);
    else if (event.key === "Escape") {
      if (selected) clearSelection();
      else if (input.onEscape) input.onEscape();
      else handled = false;
    } else if (event.key.length === 1 && !mod && !event.altKey && event.key !== " ") typeahead(event.key);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return { selected, onKeyDown, toggle, startMultiselect, clearSelection, extend };
}
