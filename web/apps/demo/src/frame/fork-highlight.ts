/**
 * The fork point in view (FOCUS_MODE.md §6.1): while following, the
 * branches of a message in the middle of the chat glow on the map. An
 * IntersectionObserver watches only the messages branches fork from, so
 * scrolling costs nothing per frame.
 */
import type { BranchView } from "@tangent/client";
import { useEffect, useMemo, useState } from "react";

/** The middle band of the chat that counts as "here". */
const BAND = "-35% 0px -35% 0px";
const NONE: ReadonlySet<string> = new Set();

/** Message id → the branches forking from it on this line. */
export function forksOf(lineId: string, branches: readonly BranchView[]): Map<string, string[]> {
  const forks = new Map<string, string[]>();
  for (const branch of branches) {
    if (branch.parentLineId !== lineId || branch.kind === "aside") continue;
    forks.set(branch.anchorMessageId, [...(forks.get(branch.anchorMessageId) ?? []), branch.lineId]);
  }
  return forks;
}

export function useForkHighlight(lineId: string, branches: readonly BranchView[], active: boolean, revision: unknown): ReadonlySet<string> {
  const forks = useMemo(() => forksOf(lineId, branches), [lineId, branches]);
  const [inView, setInView] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    const chat = document.querySelector<HTMLElement>('[data-tg-focus-region="chat"]');
    if (!active || forks.size === 0 || !chat || typeof IntersectionObserver === "undefined") {
      setInView(NONE);
      return;
    }
    // A new observer reports every watched message at once, so the glow is not cleared first (no flicker on a refetch).
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-tg-message") ?? "";
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        setInView(new Set([...visible].flatMap((id) => forks.get(id) ?? [])));
      },
      { rootMargin: BAND },
    );
    for (const id of forks.keys()) {
      const element = chat.querySelector(`[data-tg-message="${CSS.escape(id)}"]`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [forks, active, revision]);
  return inView;
}
