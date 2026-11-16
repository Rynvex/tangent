/**
 * F16.1: merging S2's sessions and splitting them back (the records of
 * import-assembly-merge.ts), with the status line saying what happened, and
 * a time set on a merged session moving every part by the same amount.
 */
import { addSessionMerge, mergeMembers, removeSessionMerge, sessionTimes, type SessionMerge, type TimelineSession } from "@tangent/client";
import { useF14T } from "./f14-messages";

export interface UseAssemblyMergesInput {
  merges: readonly SessionMerge[];
  setMerges: (next: readonly SessionMerge[]) => void;
  /** The visible sessions' keys in order. */
  visibleKeys: () => string[];
  /** The visible sessions (merged ones as merged). */
  byKey: ReadonlyMap<string, TimelineSession>;
  mergedCounts: ReadonlyMap<string, number>;
  setStatus: (text: string) => void;
}

export function useAssemblyMerges({ merges, setMerges, visibleKeys, byKey, mergedCounts, setStatus }: UseAssemblyMergesInput) {
  const t = useF14T();
  const titleOf = (key: string) => byKey.get(key)?.conversation.title || t("import.untitled");
  const mergedCountOf = (key: string) => mergedCounts.get(key) ?? 1;

  /** Each part's new time when a merged session's time is set (or cleared); just `key` when it is not merged. */
  const partTimes = (key: string, manualTime: string | null, originals: ReadonlyMap<string, TimelineSession>): Map<string, string | null> => {
    if (mergedCountOf(key) < 2) return new Map([[key, manualTime]]);
    const parts = mergeMembers(merges, key).filter((part) => originals.has(part));
    const merged = byKey.get(key);
    const from = merged ? sessionTimes(merged).start : null;
    const to = manualTime === null ? Number.NaN : Date.parse(manualTime);
    return new Map(
      parts.map((part) => {
        if (manualTime === null || Number.isNaN(to)) return [part, manualTime] as const;
        const start = sessionTimes(originals.get(part)!).start;
        return [part, start === null || from === null ? manualTime : new Date(start + (to - from)).toISOString()] as const;
      }),
    );
  };

  return {
    partTimes,
    actions: {
      mergedCountOf,
      /** Merges `keys` (into `preferredTargetKey` when given); the kept session's key, null when there was nothing to merge. */
      mergeSessions: (keys: readonly string[], preferredTargetKey?: string): string | null => {
        const next = addSessionMerge(merges, visibleKeys(), keys, preferredTargetKey);
        const added = next.find((merge) => !merges.includes(merge));
        if (!added) return null;
        setMerges(next);
        setStatus(t("f161.merged", { n: 1 + added.absorbedKeys.length, title: titleOf(added.targetKey) }));
        return added.targetKey;
      },
      /** 拆回原本的 n 篇. */
      unmergeSession: (targetKey: string) => {
        const n = mergedCountOf(targetKey);
        if (n < 2) return;
        setMerges(removeSessionMerge(merges, targetKey));
        setStatus(t("f161.unmerged", { title: titleOf(targetKey), n }));
      },
    },
  };
}
