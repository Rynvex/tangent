import type { Memory } from "@tangent/client";
import { MEMORY_KIND_KEYS, useMemoryT } from "../i18n/memory-messages";
import { cx } from "../lib/cx";

/** One memory in a list: its kind, its text and where it came from. */
export function MemoryItem({ memory, className }: { memory: Memory; className?: string }) {
  const t = useMemoryT();
  return (
    <span className={cx("flex gap-2 text-tg-sm text-tg-foreground", className)}>
      <span className="shrink-0 pt-0.5 text-[0.6875rem] text-tg-muted">{t(MEMORY_KIND_KEYS[memory.kind])}</span>
      <span className="min-w-0 flex-1 break-words">
        {memory.text}
        {memory.source.label && <span className="block text-[0.6875rem] text-tg-subtle">{t("memory.source", { label: memory.source.label })}</span>}
      </span>
    </span>
  );
}
