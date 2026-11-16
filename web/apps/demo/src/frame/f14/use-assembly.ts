/**
 * F14 S2–S4 state: the order (time first, then what the user dragged), the
 * mode, the per-node edits, the main line's title / folder / tags, and the
 * blueprint they make (import-assembly-build.ts). Pure derivations; the
 * import itself is in use-assembly-import.ts. B21: the folder starts as the
 * one the conversations came with (a combined export's projectName) until
 * the user picks one (use-organize.ts).
 *
 * F16.1: merged sessions (import-assembly-merge.ts) are applied on top of the
 * picked sessions and the user's edits, which stay in the original sessions'
 * terms (use-assembly-edits.ts), so splitting a merge back gives every piece
 * its edits. Batch roles, group moves, and a status line for what a drop or
 * a batch action did (a mode switched to the tree by one is said there).
 */
import {
  applySessionMerges,
  buildAssemblyBlueprint,
  filledTimes,
  mergeMembers,
  moveSession,
  moveSessionsToIndex,
  orderByTime,
  placeSession,
  type AssemblyEdits,
  type AssemblyMode,
  type ImportEdits,
  type SessionMerge,
  type TimelineSession,
} from "@tangent/client";
import { useCallback, useMemo, useState } from "react";
import { useF13ImportT } from "../f13-import-messages";
import { useF14T } from "./f14-messages";
import { attachValue, type AttachOption } from "./node-role-menu";
import { folderOf } from "./organize-fields";
import { clockOf } from "./time-format";
import { useAssemblyEdits } from "./use-assembly-edits";
import { useAssemblyMerges } from "./use-assembly-merges";
import { useOrganize } from "./use-organize";

const NO_EDITS: ImportEdits = { roles: {}, removed: new Set() };

export interface UseAssemblyInput {
  /** The picked sessions with the times the user set. */
  sessions: readonly TimelineSession[];
  /** The tenant's folders (the folder select's choices). */
  folders: readonly string[];
  relations: boolean;
  onSetTime: (key: string, manualTime: string | null) => void;
}

/** F16.2: everything the user arranged in S2–S3 (edits in the original sessions' terms), to keep and give back whole. */
export interface AssemblyState {
  order: readonly string[];
  mode: AssemblyMode;
  edits: AssemblyEdits;
  merges: readonly SessionMerge[];
}

/** What the last drop or batch action did; `id` changes with every one (the same words are said again). */
export interface StepStatus {
  text: string;
  id: number;
}

/** "§1 #4（14:58） 之後" for every kept message of every chapter. */
function attachOptionsOf(chapters: ReadonlyArray<{ session: TimelineSession; chapter: number }>, edits: AssemblyEdits, t: ReturnType<typeof useF14T>): AttachOption[] {
  return chapters.flatMap(({ session, chapter }) =>
    filledTimes(session, edits).map((item) => {
      const n = session.conversation.messages.findIndex((message) => message.externalId === item.externalId) + 1;
      const pos = item.at !== null ? t("assembly.pos", { c: chapter, n, time: clockOf(item.at) }) : t("assembly.posNoTime", { c: chapter, n });
      const point = { sessionKey: session.key, externalId: item.externalId };
      return { value: attachValue(point), label: t("assembly.afterPos", { pos }), point };
    }),
  );
}

/** The picked sessions in the user's order (sessions checked after going back join by time). */
function useOrderedSessions(sessions: readonly TimelineSession[]) {
  const [order, setOrder] = useState<readonly string[]>(() => orderByTime(sessions));
  const originals = useMemo(() => new Map(sessions.map((session) => [session.key, session])), [sessions]);
  const orderedOriginal = useMemo(() => {
    const known = order.filter((key) => originals.has(key));
    const keys = known.length === sessions.length ? known : orderByTime(sessions, known);
    return keys.map((key) => originals.get(key)!);
  }, [order, originals, sessions]);
  return { order, setOrder, originals, orderedOriginal };
}

function useStepStatus() {
  const [status, setStatus] = useState<StepStatus>({ text: "", id: 0 });
  const say = useCallback((text: string) => setStatus((current) => ({ text, id: current.id + 1 })), []);
  const clearStatus = useCallback(() => setStatus((current) => (current.text ? { text: "", id: current.id } : current)), []);
  return { status, say, clearStatus };
}

export function useAssembly({ sessions, folders, relations, onSetTime }: UseAssemblyInput) {
  const t = useF14T();
  const f13 = useF13ImportT();
  const labels = useMemo(() => ({ edit: (text: string) => f13("import.purposeEdit", { text }), regenerate: (text: string) => f13("import.purposeRegenerate", { text }) }), [f13]);
  const { order, setOrder, originals, orderedOriginal } = useOrderedSessions(sessions);
  const [mode, setMode] = useState<AssemblyMode>("timeline");
  const [edits, setEdits] = useState<AssemblyEdits>({});
  const [merges, setMerges] = useState<readonly SessionMerge[]>([]);
  const { status, say, clearStatus } = useStepStatus();
  const { organize, setOrganize } = useOrganize(sessions, folders);
  const applied = useMemo(() => applySessionMerges(orderedOriginal, merges, edits), [orderedOriginal, merges, edits]);
  const ordered = applied.sessions;
  const effective = applied.edits;
  const byKey = useMemo(() => new Map(ordered.map((session) => [session.key, session])), [ordered]);
  const blueprint = useMemo(
    () => buildAssemblyBlueprint({ mode, sessions: ordered, edits: effective, options: { title: organize.title, folder: folderOf(organize), tags: organize.tags, labels }, relations }),
    [mode, ordered, effective, organize, relations, labels],
  );
  const chapters = useMemo(() => blueprint.nodes.flatMap((node) => (node.role === "chapter" && node.chapter !== null ? [{ session: byKey.get(node.key)!, chapter: node.chapter }] : [])), [blueprint, byKey]);
  const attachOptions = useMemo(() => attachOptionsOf(chapters, effective, t), [chapters, effective, t]);

  const visibleKeys = () => ordered.map((session) => session.key);
  /** A new order of the visible sessions, each merged one followed by its parts (so splitting puts them back there). */
  const setVisibleOrder = (keys: readonly string[]) => setOrder(keys.flatMap((key) => mergeMembers(merges, key)));
  const writers = useAssemblyEdits({ t, mode, setMode, effective, ordered, orderedOriginal, merges, setEdits, blueprint, say, setVisibleOrder });
  const merging = useAssemblyMerges({ merges, setMerges, visibleKeys, byKey, mergedCounts: applied.mergedCounts, setStatus: say });

  return {
    order,
    /** F16.2: the arrangement as it is (the edits in the original sessions' terms), and putting one back whole. */
    state: { order, mode, edits, merges } satisfies AssemblyState,
    restore: (next: AssemblyState) => {
      setOrder(next.order);
      setMode(next.mode);
      setEdits(next.edits);
      setMerges(next.merges);
    },
    /** The picked sessions before merging, in order. */
    orderedOriginal,
    say,
    ordered,
    byKey,
    mode,
    /** The edits as the blueprint sees them (merged sessions' terms). */
    edits: effective,
    organize,
    setOrganize,
    blueprint,
    attachOptions,
    status,
    clearStatus,
    messageEdits: (key: string) => effective.messages?.[key] ?? NO_EDITS,
    /** 改用樹狀圖, or a card: never switched without the user (decision #2). */
    setMode,
    move: (key: string, delta: number) => setVisibleOrder(moveSession(visibleKeys(), key, delta)),
    place: (key: string, index: number) => setVisibleOrder(placeSession(visibleKeys(), key, index)),
    /** One or several sessions (in their order) moved to `targetIndex` (a drop). */
    placeBatch: (keys: readonly string[], targetIndex: number) => setVisibleOrder(moveSessionsToIndex(visibleKeys(), keys, targetIndex)),
    /** Moves `keys` right after `targetKey` in the timeline order. */
    moveBatchAfter: (keys: readonly string[], targetKey: string) => {
      const remaining = visibleKeys().filter((key) => !keys.includes(key));
      const at = remaining.indexOf(targetKey);
      if (at < 0) return;
      setVisibleOrder(moveSessionsToIndex(visibleKeys(), keys, at + 1));
      const targetTitle = byKey.get(targetKey)?.conversation.title || t("import.untitled");
      say(t("f161.movedAfter", { n: keys.length, title: targetTitle }));
    },
    /** A time set re-sorts at once (decision #4), keeping the dragged order among equal times; a merged session moves every part. */
    setTime: (key: string, manualTime: string | null) => {
      const times = merging.partTimes(key, manualTime, originals);
      for (const [part, time] of times) onSetTime(part, time);
      setOrder((current) => orderByTime(sessions.map((session) => (times.has(session.key) ? { ...session, manualTime: times.get(session.key) } : session)), current));
    },
    ...writers,
    ...merging.actions,
    /** The original sessions a visible one stands for (what an import remembers as imported). */
    partsOf: (key: string) => mergeMembers(merges, key).flatMap((part) => (originals.has(part) ? [originals.get(part)!] : [])),
  };
}

export type Assembly = ReturnType<typeof useAssembly>;
