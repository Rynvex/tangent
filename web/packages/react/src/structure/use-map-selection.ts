/** The map's multi-select (C2; interactions.md multiselect): a mode in which choosing a node toggles it instead of entering it. */
import type { BranchView } from "@tangent/client";
import { useMemo, useState } from "react";

export function useMapSelection(branches: readonly BranchView[], enabled: boolean) {
  const [selecting, setSelecting] = useState(false);
  const [keys, setKeys] = useState<readonly string[]>([]);
  const active = enabled && selecting;
  const selected = useMemo(() => {
    const byId = new Map(branches.map((branch) => [branch.lineId, branch]));
    return keys.flatMap((key) => byId.get(key) ?? []);
  }, [branches, keys]);
  const done = () => {
    setSelecting(false);
    setKeys([]);
  };
  return {
    active,
    selected,
    /** Whether a node is selected; undefined when it cannot be (not selecting, or the main line). */
    stateOf: (key: string): boolean | undefined => (active && branches.some((branch) => branch.lineId === key) ? keys.includes(key) : undefined),
    toggle: (key: string) => setKeys((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key])),
    setSelecting: (on: boolean) => (on ? setSelecting(true) : done()),
    done,
  };
}
