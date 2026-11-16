import { isFeatureOn, type Memory } from "@tangent/client";
import { useId, useState } from "react";
import { useMemorySearch } from "../data/memory-hooks";
import { useCapabilities } from "../data/queries";
import { useMemoryT } from "../i18n/memory-messages";
import { useDebounced } from "../lib/use-debounced";
import { MemoryItem } from "./memory-item";
import { recallBlock } from "./memory-text";

/** How long the purpose must rest before searching. */
const SEARCH_DELAY_MS = 400;

export interface BranchMemoryRecallProps {
  /** The branch's purpose as typed. */
  purpose: string;
  /** The block to add to the branch's background ("" when none is ticked). */
  onChange: (block: string) => void;
}

/**
 * The branch form's memory hint (D1; components.md `OpenBranchDialog` 記憶提示):
 * what earlier conversations concluded about the purpose, each to tick; the
 * ticked ones go into the branch's background. Nothing is ticked at first.
 */
export default function BranchMemoryRecall({ purpose, onChange }: BranchMemoryRecallProps) {
  const t = useMemoryT();
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "memory");
  const query = useDebounced(purpose, SEARCH_DELAY_MS);
  const search = useMemorySearch(query, on);
  const labelId = useId();
  const [ticked, setTicked] = useState<readonly Memory[]>([]);
  const found = (search.data?.results ?? []).map((result) => result.memory);
  // A ticked memory stays listed (to untick) after the purpose changes and the search no longer finds it.
  const shown = [...ticked.filter((memory) => !found.some((item) => item.id === memory.id)), ...found];
  if (!on || shown.length === 0) return null;
  const toggle = (memory: Memory) => {
    const next = ticked.some((item) => item.id === memory.id) ? ticked.filter((item) => item.id !== memory.id) : [...ticked, memory];
    setTicked(next);
    onChange(recallBlock(next, t));
  };
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5 rounded-tg border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-3 py-2.5">
      <span id={labelId} className="text-tg-xs font-semibold text-tg-suggestion">
        {t("recall.branchTitle")}
      </span>
      {shown.map((memory) => (
        <label key={memory.id} className="flex cursor-pointer items-start gap-2 pointer-coarse:min-h-11">
          <input
            type="checkbox"
            aria-label={t("recall.branchItem", { text: memory.text })}
            checked={ticked.some((item) => item.id === memory.id)}
            onChange={() => toggle(memory)}
            className="mt-1 accent-(--tg-primary)"
          />
          <MemoryItem memory={memory} className="flex-1" />
        </label>
      ))}
    </div>
  );
}

export { BranchMemoryRecall };
