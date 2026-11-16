/**
 * F14 S4: sending the assembly (import-assembly-run.ts) from the dialog:
 * progress "匯入中…（i / n）" (B21: "伺服器忙碌，稍候重試…" while a request
 * waits out the rate limit), nothing made (寫入失敗: the structure and the
 * edits stay, try again), some made (批次部分失敗: retry just that one; the
 * ones made stay), and, when all are in, the outcome for the frame (the
 * toast with 復原這次匯入, where to go, the panel or the banner).
 */
import { runAssembly, type AssemblyBlueprint, type AssemblyRun, type ImportConversationInput, type TimelineSession } from "@tangent/client";
import { describeError, useDeleteLine, useTangent, useTangentClient, useUiT } from "@tangent/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useF14T } from "./f14-messages";
import { useUndoWords } from "./undo-words";
import { rememberImported, undoOf, type ImportOutcome } from "./outcome";

export type ImportFailure =
  | { kind: "write"; reason: string; decompose: boolean }
  | { kind: "partial"; reason: string; title: string; made: number; total: number; index: number; run: AssemblyRun; imports: readonly ImportConversationInput[]; keys: readonly string[][]; decompose: boolean };

/** How far the import is; `waiting` while a request waits out `429 rate_limited` before it is sent again (B21). */
export interface ImportProgress {
  decompose: boolean;
  done: number;
  total: number;
  waiting?: boolean;
}

export interface UseAssemblyImportInput {
  blueprint: AssemblyBlueprint;
  /** The original sessions an import key stands for (F16.1: a merged one is several; each is remembered as imported). */
  partsOf: (key: string) => readonly TimelineSession[];
  relate: boolean;
  onDone: (outcome: ImportOutcome) => void;
}

export function useAssemblyImport({ blueprint, partsOf, relate, onDone }: UseAssemblyImportInput) {
  const t = useF14T();
  const u = useUndoWords();
  const ui = useUiT();
  const { hostErrorText, keys } = useTangent();
  const client = useTangentClient();
  const queryClient = useQueryClient();
  const deleting = useDeleteLine();
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  /** The outcome went to the frame (once: 完成 and closing the dialog after a partial failure both hand it over). */
  const handed = useRef(false);
  // B20.1: write each lineView as it lands, and invalidate the lists and counts once at the end of the batch (not per item).
  const adapter = {
    importConversation: async (input: ImportConversationInput) => {
      const result = await client.importConversation(input);
      queryClient.setQueryData(keys.lineView(result.line.id), result.line);
      return result;
    },
    createRelation: client.createRelation,
    deleteLine: deleting.mutateAsync,
  };
  const invalidateOnce = () => {
    void queryClient.invalidateQueries({ queryKey: keys.lineLists() });
    void queryClient.invalidateQueries({ queryKey: keys.lineOrganization() });
  };
  const reason = (error: unknown) => describeError(error, ui, hostErrorText);
  const retry = { onWait: () => setProgress((current) => (current ? { ...current, waiting: true } : current)) };

  const finish = (run: AssemblyRun, keys: readonly string[][], decompose: boolean) => {
    if (handed.current) return;
    handed.current = true;
    const made = run.lineIds.flatMap((id) => (id ? [id] : []));
    const madeKeys = keys.filter((_, index) => run.lineIds[index]).flat();
    rememberImported(madeKeys.flatMap(partsOf));
    const { summary } = blueprint;
    onDone({
      lineIds: made,
      focusLineId: made[0]!,
      messageCount: summary.messages,
      decompose,
      assembled: true,
      toast: made.length === 1 ? t("done.toast", { c: summary.chapters, b: summary.cards }) : t("done.toastLines", { n: made.length, c: summary.chapters, b: summary.cards }),
      undo: undoOf(deleting.mutateAsync, made, u),
    });
  };

  const settle = (run: AssemblyRun, imports: readonly ImportConversationInput[], keys: readonly string[][], decompose: boolean) => {
    if (run.lineIds.some(Boolean)) invalidateOnce();
    const [first] = run.failures;
    if (!first) return finish(run, keys, decompose);
    if (run.lineIds.every((id) => id === null)) return setFailure({ kind: "write", reason: reason(first.error), decompose });
    const title = imports[first.index]?.title ?? "";
    setFailure({ kind: "partial", reason: reason(first.error), title, made: run.lineIds.filter(Boolean).length, total: imports.length, index: first.index, run, imports, keys, decompose });
  };

  const submit = async (decompose: boolean) => {
    const imports = blueprint.imports;
    const keys = blueprint.importKeys;
    setFailure(null);
    setProgress({ decompose, done: 0, total: imports.length });
    const run = await runAssembly(adapter, imports, { relate, retry, onProgress: (done, total) => setProgress({ decompose, done, total }) });
    setProgress(null);
    settle(run, imports, keys, decompose);
  };

  /** 只重試這一篇: the failed import alone, related to its neighbours; the ones made before are kept. */
  const retryOne = async () => {
    if (failure?.kind !== "partial") return;
    const { imports, keys, decompose, index, run: before } = failure;
    setProgress({ decompose, done: 0, total: 1 });
    const again = await runAssembly(adapter, imports, { relate, retry, only: [index], made: before.lineIds });
    setProgress(null);
    const failures = [...before.failures.filter((item) => item.index !== index), ...again.failures];
    settle({ ...again, failures }, imports, keys, decompose);
  };

  /** 完成 after a partial failure: what was made is kept and opened. */
  const finishPartial = () => {
    if (failure?.kind === "partial") finish(failure.run, failure.keys, failure.decompose);
  };

  /** 再試一次 after nothing was made: the same choice again. */
  const retryWrite = () => {
    if (failure?.kind === "write") void submit(failure.decompose);
  };

  return { progress, failure, submit, retry: retryWrite, retryOne, finishPartial, busy: progress !== null };
}
