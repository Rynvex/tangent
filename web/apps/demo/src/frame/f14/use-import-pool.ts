/**
 * F14 S1: the conversations the import dialog can pick from: every loaded
 * file (several at once, added in turns, each parsed on its own; a file that
 * cannot be read does not touch the others) and the pasted text. Each file
 * keeps its `lastModified` so a conversation without dates is placed by it
 * (decision #4). Files are untrusted: parsed as data, never put in the page.
 */
import { IMPORT_MAX_FILE_BYTES, parseImport, type ImportSourceKind, type ParsedConversation, type ParsedImport } from "@tangent/client";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createImportParser, ImportParseSuperseded, type ImportParser } from "../import-parse";

export interface PoolFile {
  id: number;
  name: string;
  size: number;
  status: "reading" | "ready" | "failed";
  /** Why it failed: over 20 MB, not an export we read, or the read itself. */
  error: "tooLarge" | "unreadable" | "read" | null;
  reason: string;
  parsed: ParsedImport | null;
}

/** One conversation that can be picked. */
export interface PoolEntry {
  key: string;
  /** 0 for the pasted text. */
  fileId: number;
  fileName: string;
  source: ImportSourceKind;
  parsed: ParsedImport;
  conversation: ParsedConversation;
}

const PASTED = 0;

const TITLE_RUNES = 60;

/**
 * A conversation without a title (a transcript) is named after its file ("壓測筆記.md" → 壓測筆記), or, pasted, by its first
 * prompt as the server names it (domain.ImportTitle).
 */
function titled(conversation: ParsedConversation, fileName: string): ParsedConversation {
  if (conversation.title.trim()) return conversation;
  const stem = fileName.replace(/\.[^.]+$/, "").trim();
  if (stem) return { ...conversation, title: stem };
  const first = (conversation.messages.find((message) => message.role === "user") ?? conversation.messages[0])?.content.replace(/\s+/g, " ").trim() ?? "";
  const chars = Array.from(first);
  return { ...conversation, title: chars.length <= TITLE_RUNES ? first : `${chars.slice(0, TITLE_RUNES - 1).join("")}…` };
}

/** The pool's entries: files in the order added, then the pasted text. */
function entriesOf(files: readonly PoolFile[], pasted: ParsedImport | null): PoolEntry[] {
  const fromFile = (fileId: number, fileName: string, parsed: ParsedImport) =>
    parsed.conversations.map((conversation, index) => ({ key: `${fileId}:${index}:${conversation.id}`, fileId, fileName, source: parsed.source, parsed, conversation: titled(conversation, fileName) }));
  return [...files.flatMap((file) => (file.parsed ? fromFile(file.id, file.name, file.parsed) : [])), ...(pasted ? fromFile(PASTED, "", pasted) : [])];
}

export function useImportPool() {
  const [files, setFiles] = useState<readonly PoolFile[]>([]);
  const [pastedText, setPastedText] = useState("");
  const deferred = useDeferredValue(pastedText);
  const pasted = useMemo(() => {
    const result = deferred.trim() ? parseImport(deferred) : null;
    return { parsed: result?.ok ? result.value : null, failed: result && !result.ok ? result.error : null };
  }, [deferred]);
  const nextId = useRef(PASTED + 1);
  const parsers = useRef(new Map<number, ImportParser>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const running = parsers.current;
    return () => {
      alive.current = false;
      for (const parser of running.values()) parser.dispose();
      running.clear();
    };
  }, []);
  const patch = (id: number, change: Partial<PoolFile>) => {
    if (alive.current) setFiles((current) => current.map((file) => (file.id === id ? { ...file, ...change } : file)));
  };

  const readOne = async (file: File, id: number) => {
    if (file.size > IMPORT_MAX_FILE_BYTES) return patch(id, { status: "failed", error: "tooLarge" });
    const parser = createImportParser();
    parsers.current.set(id, parser);
    try {
      const text = await file.text();
      if (!parsers.current.has(id)) return;
      const result = await parser.parse(text, file.name, file.size, new Date(file.lastModified || Date.now()).toISOString());
      patch(id, result.ok ? { status: "ready", parsed: result.value } : { status: "failed", error: "unreadable" });
    } catch (error) {
      if (error instanceof ImportParseSuperseded) return;
      patch(id, { status: "failed", error: "read", reason: error instanceof Error ? error.message : String(error) });
    } finally {
      parser.dispose();
      parsers.current.delete(id);
    }
  };

  const addFiles = (list: readonly File[]) => {
    const added = list.map((file) => ({ file, id: (nextId.current += 1) }));
    setFiles((current) => [...current, ...added.map(({ file, id }): PoolFile => ({ id, name: file.name, size: file.size, status: "reading", error: null, reason: "", parsed: null }))]);
    for (const { file, id } of added) void readOne(file, id);
  };

  const removeFile = (id: number) => {
    parsers.current.get(id)?.dispose();
    parsers.current.delete(id);
    setFiles((current) => current.filter((file) => file.id !== id));
  };

  const entries = useMemo(() => entriesOf(files, pasted.parsed), [files, pasted.parsed]);
  return { files, addFiles, removeFile, pastedText, setPastedText, pastedFailure: pasted.failed, entries };
}

export type ImportPool = ReturnType<typeof useImportPool>;
