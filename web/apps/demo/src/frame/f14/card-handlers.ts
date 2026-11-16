/**
 * F16.1: the per-card state of S2's list (which cards and stretches are
 * open, what a keyboard move announced) and each SessionNodeCard's handlers.
 * After a merge, a split or a move the card's own control takes focus back
 * (the one that was pressed may be gone), and a merged or split card's open
 * stretch is closed (its numbering changed).
 */
import type { TimelineSession } from "@tangent/client";
import { useState } from "react";
import { useF14T } from "./f14-messages";
import type { NodeCardHandlers } from "./session-node-card";
import type { Assembly } from "./use-assembly";
import type { AssemblyDnd } from "./use-assembly-drag";

/** After a change that moves or remounts the focused control, focus `selector` again (only when focus was lost). */
export function refocus(selector: string): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return;
    document.querySelector<HTMLElement>(selector)?.focus();
  });
}

/** The role button of a session's card (`card`) or of its node in the preview. */
export const roleButtonOf = (key: string, where: "card" | "preview") => `[data-tg-${where === "card" ? "session-node" : "blueprint-node"}="${CSS.escape(key)}"] [data-tg-role-trigger]`;

const toggled = (set: ReadonlySet<string>, key: string) => (set.has(key) ? new Set([...set].filter((item) => item !== key)) : new Set([...set, key]));

export function useCardHandlers(assembly: Assembly, dnd: AssemblyDnd) {
  const t = useF14T();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [segments, setSegments] = useState<Readonly<Record<string, number | null>>>({});
  const [said, setSaid] = useState("");
  const { ordered } = assembly;
  const closeSegment = (key: string) => setSegments((current) => ({ ...current, [key]: null }));
  const move = (session: TimelineSession, delta: number) => {
    const keys = ordered.map((item) => item.key);
    const at = keys.indexOf(session.key);
    const next = Math.min(Math.max(at + delta, 0), keys.length - 1);
    if (next === at) return;
    assembly.move(session.key, delta);
    setSaid(t("import.moved", { title: session.conversation.title || t("import.untitled"), n: next + 1 }));
    refocus(`[data-tg-session-node="${CSS.escape(session.key)}"] [data-tg-handle]`);
  };
  const merge = (keys: readonly string[], target?: string) => {
    const kept = assembly.mergeSessions(keys, target);
    if (kept) {
      closeSegment(kept);
      refocus(roleButtonOf(kept, "card"));
    }
    return kept;
  };
  const unmerge = (key: string) => {
    assembly.unmergeSession(key);
    closeSegment(key);
    refocus(roleButtonOf(key, "card"));
  };
  const handlersFor = (session: TimelineSession, index: number, shownKeys: readonly string[]): NodeCardHandlers => {
    const above = ordered[index - 1];
    return {
      onToggleExpand: () => setExpanded((current) => toggled(current, session.key)),
      onOpenSegment: (segment) => setSegments((current) => ({ ...current, [session.key]: segment })),
      onSetTime: (value) => assembly.setTime(session.key, value),
      onMove: (delta) => move(session, delta),
      onRole: (role) => assembly.setRole(session.key, role),
      onAttach: (point) => assembly.setAttach(session.key, point),
      onToggleRole: (externalId, role) => assembly.toggleMessageRole(session.key, externalId, role),
      onToggleRemoved: (externalId) => assembly.toggleRemoved(session.key, externalId),
      onDragStart: () => dnd.start(session.key),
      onDragEnd: dnd.end,
      onDropHere: () => {
        if (dnd.isDragging()) dnd.drop({ kind: "index", index });
      },
      onSelect: (range) => dnd.selection.toggle(session.key, range, shownKeys),
      onMergeUp: above ? () => void merge([above.key, session.key], above.key) : null,
      onUnmerge: () => unmerge(session.key),
      onAttachSelectedHere: () => {
        assembly.setRoleBatch(dnd.selection.ordered, "merged_branch", session.key);
        dnd.selection.clear();
        refocus(roleButtonOf(session.key, "card"));
      },
      onMergeSelectedHere: () => {
        merge([...dnd.selection.ordered, session.key], session.key);
        dnd.selection.clear();
      },
      onMoveSelectedAfter: () => {
        assembly.moveBatchAfter(dnd.selection.ordered, session.key);
        dnd.selection.clear();
        refocus(`[data-tg-session-node="${CSS.escape(session.key)}"] [data-tg-handle]`);
      },
    };
  };
  return { expanded, segments, said, merge, handlersFor };
}
