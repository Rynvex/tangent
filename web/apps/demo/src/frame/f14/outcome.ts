/**
 * What an import (F13's quick single one or an F14 assembly) hands the frame
 * when it is done: where to go, what to say, and how to undo it (decision
 * #8: deleting the main lines it made with `DELETE /lines/{id}`). The words
 * are made here, in the dialog's chunk, so the frame only shows them.
 */
import { sessionSourceId, undoAssembly, type ImportSourceKind, type ParsedConversation } from "@tangent/client";
import { undoText } from "./undo-words";

export interface ImportOutcome {
  /** Every main line the import made. */
  lineIds: readonly string[];
  /** Where the frame goes: the first one in time order. */
  focusLineId: string;
  /** Messages imported (the banner's number). */
  messageCount: number;
  /** 確認結構並展開拆解建議 was pressed (desktop opens the panel; phones show the banner instead). */
  decompose: boolean;
  /** An F14 assembly (the banner says 已匯入 m 則・k 項拆解建議). */
  assembled: boolean;
  toast: string;
  undo: { label: string; run: () => Promise<string> };
}

/**
 * The undo of an import: deletes its main lines and says how it went (undoText: failed, kept in another conversation, or
 * deleted). `deleteLine` is useDeleteLine's (it forgets the deleted trees in the cache at once, not only when `line.deleted`
 * arrives).
 */
export function undoOf(deleteLine: Parameters<typeof undoAssembly>[0]["deleteLine"], lineIds: readonly string[], u: Parameters<typeof undoText>[1]): ImportOutcome["undo"] {
  return {
    label: u("done.undo"),
    run: async () => undoText(await undoAssembly({ deleteLine }, lineIds), u),
  };
}

const STORAGE_KEY = "tangent.f14.imported";

/** The source ids imported in this browser session (decision #10); empty when storage is unavailable. */
export function readImportedIds(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remembers what was just imported; storage failing only loses the hint. */
export function rememberImported(items: ReadonlyArray<{ source: ImportSourceKind; conversation: ParsedConversation }>): void {
  const ids = items.flatMap((item) => {
    const id = sessionSourceId(item.source, item.conversation);
    return id ? [id] : [];
  });
  if (ids.length === 0) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set([...readImportedIds(), ...ids])]));
  } catch {
    // Private mode or full storage: the duplicate hint just cannot use this session's imports.
  }
}
