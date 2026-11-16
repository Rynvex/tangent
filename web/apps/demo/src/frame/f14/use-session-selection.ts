/**
 * F16.1: the sessions checked in S2 for a batch action. A plain click (or
 * Space) toggles one; Shift with it sets every shown session between the
 * last one toggled and this one to this one's new state. The selection
 * follows the visible sessions (a merged-away or unpicked one leaves it).
 */
import { useEffect, useMemo, useRef, useState } from "react";

export interface SessionSelection {
  /** The selected keys in the sessions' order. */
  ordered: readonly string[];
  size: number;
  has: (key: string) => boolean;
  /** Toggles `key`; `range` (Shift) also sets the shown ones between the last toggled and it. */
  toggle: (key: string, range: boolean, shown: readonly string[]) => void;
  /** Selects (or clears) all of `keys`. */
  setMany: (keys: readonly string[], on: boolean) => void;
  clear: () => void;
}

/** The keys between `from` and `to` in `shown`, both included; just `to` when `from` is not shown. */
export function rangeOf(shown: readonly string[], from: string | null, to: string): string[] {
  const a = from === null ? -1 : shown.indexOf(from);
  const b = shown.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return shown.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function useSessionSelection(visible: readonly string[]): SessionSelection {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const ordered = useMemo(() => visible.filter((key) => chosen.has(key)), [visible, chosen]);
  const live = useMemo(() => new Set(ordered), [ordered]);
  // A session merged away or unpicked leaves the selection (it would come back checked when split again).
  const shownKey = visible.join("\n");
  useEffect(() => {
    setChosen((current) => {
      const kept = [...current].filter((key) => visible.includes(key));
      return kept.length === current.size ? current : new Set(kept);
    });
    // `shownKey` stands for `visible` (a new array on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);
  const setMany = (keys: readonly string[], on: boolean) =>
    setChosen((current) => {
      const next = new Set([...current].filter((key) => visible.includes(key)));
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  return {
    ordered,
    size: ordered.length,
    has: (key) => live.has(key),
    toggle: (key, range, shown) => {
      const on = !live.has(key);
      setMany(range ? rangeOf(shown, anchor.current, key) : [key], on);
      anchor.current = key;
    },
    setMany,
    clear: () => {
      anchor.current = null;
      setChosen(new Set());
    },
  };
}
