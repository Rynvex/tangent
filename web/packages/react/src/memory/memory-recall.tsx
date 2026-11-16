import { isFeatureOn } from "@tangent/client";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { useMemorySearch } from "../data/memory-hooks";
import { useCapabilities } from "../data/queries";
import { useMemoryT } from "../i18n/memory-messages";
import { cx } from "../lib/cx";
import { MemoryItem } from "./memory-item";
import { recallBlock } from "./memory-text";

export interface MemoryRecallProps {
  /** A new conversation's first message (the host debounces it). */
  query: string;
  /** 帶入: the block the host puts at the start of the message. */
  onUse: (block: string) => void;
  className?: string;
}

/**
 * 你之前得出過 (D1; components.md `MemoryRecall`: dashed card, p 12; prompt,
 * brought in, dismissed): what earlier conversations concluded about a new
 * conversation's first message, above the composer. It never pops up or
 * takes focus; nothing comes in unless the user says so.
 */
export default function MemoryRecall({ query, onUse, className }: MemoryRecallProps) {
  const t = useMemoryT();
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "memory");
  const search = useMemorySearch(query, on);
  const headingId = useId();
  const [state, setState] = useState<{ query: string; outcome: "used" | "dismissed"; count: number } | null>(null);
  const decided = state?.query === query ? state : null;
  const results = search.data?.results ?? [];
  if (!on || decided?.outcome === "dismissed") return null;
  if (decided?.outcome === "used") {
    return (
      <p role="status" className={cx("m-0 rounded-tg-sm bg-tg-primary-soft px-2.5 py-2 text-tg-xs text-tg-foreground", className)}>
        {t("recall.used", { count: decided.count })}
      </p>
    );
  }
  if (results.length === 0) return null;
  const memories = results.map((result) => result.memory);
  return (
    <section aria-labelledby={headingId} className={cx("flex flex-col gap-1.5 rounded-tg border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-3 py-3", className)}>
      <span id={headingId} className="text-tg-xs font-semibold text-tg-suggestion">
        {t("recall.title")}
      </span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {memories.map((memory) => (
          <li key={memory.id}>
            <MemoryItem memory={memory} />
          </li>
        ))}
      </ul>
      <span className="flex gap-1.5">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            onUse(recallBlock(memories, t));
            setState({ query, outcome: "used", count: memories.length });
          }}
        >
          {t("recall.use", { count: memories.length })}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setState({ query, outcome: "dismissed", count: 0 })}>
          {t("recall.dismiss")}
        </Button>
      </span>
    </section>
  );
}

export { MemoryRecall };
