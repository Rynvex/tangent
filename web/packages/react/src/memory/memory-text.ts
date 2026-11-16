import type { Memory } from "@tangent/client";
import { MEMORY_KIND_KEYS, type useMemoryT } from "../i18n/memory-messages";

type MemoryT = ReturnType<typeof useMemoryT>;

/** What 帶入 puts in a message or a branch's background: a lead line and one line per memory. */
export function recallBlock(memories: readonly Memory[], t: MemoryT): string {
  if (memories.length === 0) return "";
  return [t("recall.lead"), ...memories.map((memory) => t("recall.line", { kind: t(MEMORY_KIND_KEYS[memory.kind]), text: memory.text }))].join("\n");
}
