/**
 * F16.1: dragging S2's sessions (one, or every checked one when a checked
 * one is grabbed) from either column onto a place: a spot in the order, a
 * role zone, a chapter (hang under it or merge into it). Every target can
 * also be pressed, which applies it to the checked sessions: the path
 * without dragging (keyboard, or a mouse that would rather click).
 */
import type { NodeRole } from "@tangent/client";
import { createContext, useContext, useRef, useState } from "react";
import { refocus, roleButtonOf } from "./card-handlers";
import type { Assembly } from "./use-assembly";
import type { SessionSelection } from "./use-session-selection";

export type DropTarget = { kind: "role"; role: NodeRole } | { kind: "attach"; chapterKey: string } | { kind: "merge"; key: string } | { kind: "index"; index: number };

export interface AssemblyDnd {
  /** The sessions being dragged (in order), null when nothing is. */
  dragging: readonly string[] | null;
  /** Whether a drag is on now (read at once, before the next render). */
  isDragging: () => boolean;
  selection: SessionSelection;
  start: (key: string) => void;
  end: () => void;
  drop: (target: DropTarget) => void;
  /** A target pressed: applied to the checked sessions. */
  apply: (target: DropTarget) => void;
}

export const AssemblyDndContext = createContext<AssemblyDnd | null>(null);

/** The drag state of the step; null outside it (a card rendered alone). */
export const useAssemblyDnd = () => useContext(AssemblyDndContext);

/** What a target does with `keys`. */
function act(assembly: Assembly, selection: SessionSelection, target: DropTarget, keys: readonly string[]): void {
  if (keys.length === 0) return;
  switch (target.kind) {
    case "role":
      assembly.setRoleBatch(keys, target.role);
      return;
    case "attach":
      assembly.setRoleBatch(keys, "merged_branch", target.chapterKey);
      return;
    case "merge":
      if (!assembly.mergeSessions([...keys, target.key], target.key)) return;
      selection.clear();
      // The target pressed is gone with the selection: the chapter it merged into takes focus.
      refocus(roleButtonOf(target.key, "preview"));
      return;
    case "index":
      assembly.placeBatch(keys, target.index);
  }
}

export function useAssemblyDrag(assembly: Assembly, selection: SessionSelection): AssemblyDnd {
  const [dragging, setDragging] = useState<readonly string[] | null>(null);
  const current = useRef<readonly string[] | null>(null);
  const shown = useRef(0);
  const end = () => {
    current.current = null;
    window.clearTimeout(shown.current);
    setDragging(null);
  };
  return {
    dragging,
    isDragging: () => current.current !== null,
    selection,
    start: (key) => {
      const keys = selection.has(key) ? selection.ordered : [key];
      current.current = keys;
      // Chrome ends a drag whose source moves while dragstart runs: the drop targets appear just after it.
      window.clearTimeout(shown.current);
      shown.current = window.setTimeout(() => setDragging(keys), 0);
    },
    end,
    drop: (target) => {
      const keys = current.current;
      end();
      if (keys) act(assembly, selection, target, keys);
    },
    apply: (target) => act(assembly, selection, target, selection.ordered),
  };
}
