/**
 * The frame's F13 / F14 state (docs/devlog/F13-import-organize-decompose.md,
 * F14-chronological-multi-import.md): the import dialog, the decompose
 * panel's line, the banner after an import and the messages outlined in the
 * transcript, with the actions that open and close them. Only light state
 * lives here; the dialog, the panel and the banner are their own chunks,
 * loaded the first time one shows (f13-slots.tsx mounts them).
 */
import { useDeleteLine } from "@tangent/react";
import { lazy, useEffect, useRef, useState } from "react";
import { forgetLastImport, IMPORT_UNDO_MS, readLastImport, rememberLastImport, undoable, type LastImport } from "./f14/last-import";
import type { ImportOutcome } from "./f14/outcome";
import { undoText, useUndoWords } from "./f14/undo-words";
import type { ToastAction } from "./hooks";

export const ImportDialog = lazy(() => import("./import-dialog"));
export const DecomposeHost = lazy(() => import("./f13-host").then((module) => ({ default: module.DecomposeHost })));
export const ImportedBanner = lazy(() => import("./f13-host").then((module) => ({ default: module.ImportedBanner })));

/** How long an import's toast (with 復原這次匯入) stays. */
const IMPORT_TOAST_MS = 15_000;

export interface F13FrameInput {
  /** The line on screen. */
  selected: string | null;
  navigate: (lineId: string) => void;
  /** Closes the phone's list drawer (opening the dialog or the panel from it). */
  closeList: () => void;
  /** F14: the frame's toast (the import's summary and its undo). */
  toast: (message: string, action?: ToastAction, durationMs?: number) => void;
  /** F14: phones get the banner instead of the panel covering the new conversation. */
  narrow: boolean;
}

export type F13Frame = ReturnType<typeof useF13Frame>;

/**
 * The banner on a line the import made (restored from sessionStorage after a reload while it can be undone), until it is
 * closed or undone.
 */
function bannerOn(record: LastImport | null, selected: string | null): { lineId: string; count: number; assembled: boolean } | null {
  if (!record || record.dismissed || selected === null || !record.lineIds.includes(selected)) return null;
  return { lineId: selected, count: record.messageCount, assembled: record.assembled };
}

/**
 * F14.1: 復原這次匯入 for 10 minutes, from the toast or the banner, across a reload: back to the conversation on screen
 * before (only when the screen shows what is being deleted), the import's main lines deleted, and a toast saying so.
 */
function useImportUndo(navigate: (lineId: string) => void, toast: F13FrameInput["toast"], onScreen: { current: string | null }) {
  const u = useUndoWords();
  const deleting = useDeleteLine();
  // The toast's action is made in the render that finished the import: it reads these as of now.
  const latest = useRef({ navigate, toast, u, deleting });
  useEffect(() => {
    latest.current = { navigate, toast, u, deleting };
  });
  const [record, setShown] = useState<LastImport | null>(() => readLastImport());
  // The record as of now: the toast's action is made in an older render.
  const current = useRef(record);
  const setRecord = (next: LastImport | null) => {
    current.current = next;
    setShown(next);
  };
  // The dialog's own undo while its outcome is in memory (the same deletes and words).
  const run = useRef<(() => Promise<string>) | null>(null);
  const [, expire] = useState(0);
  useEffect(() => {
    if (!record) return undefined;
    const timer = window.setTimeout(() => expire((n) => n + 1), Math.max(0, record.importedAt + IMPORT_UNDO_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [record]);
  const remember = (next: LastImport, undo: () => Promise<string>) => {
    rememberLastImport(next);
    run.current = undo;
    setRecord(next);
  };
  const dismiss = () => {
    if (!current.current) return;
    const next = { ...current.current, dismissed: true };
    rememberLastImport(next);
    setRecord(next);
  };
  const undo = () => {
    const done = current.current;
    if (!done || !undoable(done)) return;
    forgetLastImport();
    setRecord(null);
    const now = latest.current;
    const before = done.beforeLineId;
    if (before && onScreen.current && done.lineIds.includes(onScreen.current) && !done.lineIds.includes(before)) now.navigate(before);
    // B21: the undo (with its rate-limit retry) is its own chunk, loaded when pressed.
    const deleteAll = async () => {
      const { undoImportedLines } = await import("./f14/undo-run");
      return undoText(await undoImportedLines((lineId) => now.deleting.mutateAsync(lineId), done.lineIds), now.u);
    };
    const work = run.current ?? deleteAll;
    run.current = null;
    work().then(
      (message) => latest.current.toast(message),
      () => latest.current.toast(latest.current.u("done.undoFailed", { n: done.lineIds.length })),
    );
  };
  return { record, remember, dismiss, undo, canUndo: record !== null && undoable(record), label: u("done.undo") };
}

export function useF13Frame({ selected, navigate, closeList, toast, narrow }: F13FrameInput) {
  const [importOpen, setImportOpen] = useState(false);
  const [decomposeId, setDecomposeId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<readonly string[]>([]);
  // The line on screen when the toast's undo is pressed (the toast outlives the render that made it).
  const onScreen = useRef(selected);
  useEffect(() => {
    onScreen.current = selected;
  }, [selected]);
  const undo = useImportUndo(navigate, toast, onScreen);
  // S4: the panel is about the line on screen; going elsewhere closes it (decision #7: it stands in for the side panel).
  const decomposeShown = decomposeId !== null && decomposeId === selected;
  useEffect(() => {
    if (decomposeId !== null && selected !== null && decomposeId !== selected) {
      setDecomposeId(null);
      setHighlight([]);
    }
  }, [decomposeId, selected]);
  const openDecompose = (lineId: string) => {
    navigate(lineId);
    setDecomposeId(lineId);
    closeList();
  };
  /** Decision #8: 復原這次匯入 (the toast's and the banner's) closes the panel and undoes the import. */
  const undoImport = () => {
    setDecomposeId(null);
    undo.undo();
  };
  return {
    importOpen,
    setImportOpen,
    openImport: () => {
      setImportOpen(true);
      closeList();
    },
    /** The new conversation opens with the toast and its undo; with 展開拆解建議 the panel too (phones: the banner offers it). */
    onImported: (outcome: ImportOutcome) => {
      const before = selected;
      navigate(outcome.focusLineId);
      undo.remember(
        { lineIds: outcome.lineIds, focusLineId: outcome.focusLineId, beforeLineId: before, messageCount: outcome.messageCount, assembled: outcome.assembled, importedAt: Date.now() },
        outcome.undo.run,
      );
      if (outcome.decompose && !(narrow && outcome.assembled)) setDecomposeId(outcome.focusLineId);
      toast(outcome.toast, { label: outcome.undo.label, run: undoImport } satisfies ToastAction, IMPORT_TOAST_MS);
    },
    /** The banner of the import that made the line on screen (only on its lines). */
    importedHere: bannerOn(undo.record, selected),
    /** 復原這次匯入 on the banner, while the import can still be undone (10 minutes). */
    importUndo: undo.canUndo ? { label: undo.label, run: undoImport } : null,
    dismissImported: undo.dismiss,
    decomposeShown,
    openDecompose,
    closeDecompose: () => {
      setDecomposeId(null);
      setHighlight([]);
    },
    highlight,
    setHighlight,
  };
}
