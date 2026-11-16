import type { RecalledMemory } from "@tangent/client";
import { useMemoryT } from "../i18n/memory-messages";
import { MemoryItem } from "../memory/memory-item";
import { Section } from "./preview-fisheye";

/** 記憶（跨對話） (D1): the memories this turn recalls — the only place they are shown (DESIGN §12). */
export function MemoriesSection({ memories }: { memories: readonly RecalledMemory[] }) {
  const t = useMemoryT();
  return (
    <Section title={t("preview.memories")}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {memories.map(({ memory, score }) => (
          <li key={memory.id} className="flex items-start gap-2 px-1.5 py-1">
            <MemoryItem memory={memory} className="min-w-0 flex-1 text-tg-xs" />
            <span className="shrink-0 font-tg-mono text-[0.6875rem] text-tg-muted">{t("preview.memoryScore", { score: score.toFixed(2) })}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
