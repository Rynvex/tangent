/**
 * F16.1: the writers of an assembly's edits (roles, batch roles, attach
 * points, cards, message edits). The edits stay in the original sessions'
 * terms: an edit on a merged session's message or a point on it is stored
 * under the session it came from (mergedOrigin), so splitting a merge back
 * gives every piece its edits. A role the mode cannot hold switches to the
 * tree and says so in the status line.
 */
import {
  applyBatchRole,
  mergedOrigin,
  moveSessionsToIndex,
  type AssemblyBlueprint,
  type AssemblyEdits,
  type AssemblyMode,
  type AttachPoint,
  type ImportEdits,
  type ImportRole,
  type NodeRole,
  type SessionMerge,
  type TimelineSession,
} from "@tangent/client";
import type { Dispatch, SetStateAction } from "react";
import type { F14T } from "./f14-messages";

const NO_EDITS: ImportEdits = { roles: {}, removed: new Set() };

/** A role the mode cannot hold (a branch in the timeline, anything but standalone in batch) means the tree. */
const needsTree = (mode: AssemblyMode, role: NodeRole) => (mode === "timeline" && (role === "merged_branch" || role === "open_branch")) || (mode === "batch" && role !== "standalone");

export interface UseAssemblyEditsInput {
  t: F14T;
  mode: AssemblyMode;
  setMode: (mode: AssemblyMode) => void;
  /** The edits in the merged sessions' terms, and the visible (merged) sessions. */
  effective: AssemblyEdits;
  ordered: readonly TimelineSession[];
  /** The picked sessions before merging, and the merges. */
  orderedOriginal: readonly TimelineSession[];
  merges: readonly SessionMerge[];
  setEdits: Dispatch<SetStateAction<AssemblyEdits>>;
  blueprint: AssemblyBlueprint;
  say: (text: string) => void;
  /** A new order of the visible sessions. */
  setVisibleOrder: (keys: readonly string[]) => void;
}

export function useAssemblyEdits({ t, mode, setMode, effective, ordered, orderedOriginal, merges, setEdits, blueprint, say, setVisibleOrder }: UseAssemblyEditsInput) {
  const visibleKeys = () => ordered.map((session) => session.key);
  const originOf = (key: string, externalId: string) => mergedOrigin(orderedOriginal, merges, key, externalId);
  const routeAttach = (point: AttachPoint) => originOf(point.sessionKey, point.externalId);
  const patchMessages = (key: string, externalId: string, change: (current: ImportEdits, id: string) => ImportEdits) => {
    const origin = originOf(key, externalId);
    setEdits((current) => ({ ...current, messages: { ...current.messages, [origin.sessionKey]: change(current.messages?.[origin.sessionKey] ?? NO_EDITS, origin.externalId) } }));
  };
  const switchFor = (role: NodeRole) => {
    if (!needsTree(mode, role)) return false;
    setMode("tree");
    say(t("f161.switchedTree"));
    return true;
  };
  /** The visible order with `keys` (in their order) right after `chapterKey`. */
  const afterChapter = (keys: readonly string[], chapterKey: string) => {
    const at = visibleKeys().filter((key) => !keys.includes(key)).indexOf(chapterKey);
    if (at >= 0) setVisibleOrder(moveSessionsToIndex(visibleKeys(), keys, at + 1));
  };
  /** Roles (and attach points on a chapter, moving those right after it) for several sessions at once; says what happened. */
  const setRoleBatch = (keys: readonly string[], role: NodeRole, targetChapterKey?: string) => {
    const batched = applyBatchRole(effective, ordered, keys, role, targetChapterKey);
    const changed = keys.filter((key) => batched.roles?.[key] === role);
    if (changed.length === 0) return;
    const points = changed.flatMap((key) => {
      const point = batched.attach?.[key];
      return point && point !== effective.attach?.[key] ? [[key, routeAttach(point)] as const] : [];
    });
    setEdits((current) => ({ ...current, roles: { ...current.roles, ...Object.fromEntries(changed.map((key) => [key, role])) }, ...(points.length > 0 ? { attach: { ...current.attach, ...Object.fromEntries(points) } } : {}) }));
    if (targetChapterKey !== undefined && points.length > 0) afterChapter(points.map(([key]) => key), targetChapterKey);
    if (switchFor(role)) return;
    const chapter = blueprint.nodes.find((node) => node.key === targetChapterKey)?.chapter;
    say(points.length > 0 && chapter ? t("f161.attached", { n: points.length, c: chapter }) : t("f161.rolesSet", { n: changed.length, role: t(`role.short.${role}`) }));
  };
  return {
    /** A branch role in the timeline means the tree (the timeline keeps every session a chapter). */
    setRole: (key: string, role: NodeRole) => {
      switchFor(role);
      setEdits((current) => ({ ...current, roles: { ...current.roles, [key]: role } }));
    },
    setRoleBatch,
    setAttach: (key: string, point: AttachPoint) => setEdits((current) => ({ ...current, attach: { ...current.attach, [key]: routeAttach(point) } })),
    setConclusion: (key: string, conclusion: string) => setEdits((current) => ({ ...current, conclusions: { ...current.conclusions, [key]: conclusion } })),
    toggleMessageRole: (key: string, externalId: string, role: ImportRole) => patchMessages(key, externalId, (current, id) => ({ ...current, roles: { ...current.roles, [id]: role } })),
    toggleRemoved: (key: string, externalId: string) =>
      patchMessages(key, externalId, (current, id) => ({ ...current, removed: current.removed.has(id) ? new Set([...current.removed].filter((item) => item !== id)) : new Set([...current.removed, id]) })),
  };
}
