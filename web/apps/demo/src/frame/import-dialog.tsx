/**
 * The import dialog (F13 S2, F14 S1–S4; w880, step 2 1340 × 840 since F17,
 * full screen on phones), in
 * two steps: choose conversations from pasted text and any number of exports
 * (ChatGPT, Claude, Gemini, Tangent, Markdown / text; up to 20 MB each, read
 * only in this browser), then arrange them by time and choose how they are
 * assembled. One conversation can still go through F13's single form
 * (快速匯入單篇). Files are untrusted: parsed as data (JSON, or HTML in an
 * inert document), never put into the page.
 */
import { findDuplicate, knownFolderNames, knownTagCounts, type DuplicateOf, type ImportConversationResult, type TimelineSession } from "@tangent/client";
import { Dialog, DialogContent, useDeleteLine, useLineOrganization, useLines, useUiLocale } from "@tangent/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssemblyStep } from "./f14/assembly-step";
import { useF14T } from "./f14/f14-messages";
import { useUndoWords } from "./f14/undo-words";
import { ImportStepper } from "./f14/import-stepper";
import { readImportedIds, rememberImported, undoOf, type ImportOutcome } from "./f14/outcome";
import { PickStep, type SourceTab } from "./f14/pick-step";
import { useImportPool, type PoolEntry } from "./f14/use-import-pool";
import { useViewportWidth } from "./hooks";
import { ImportForm } from "./import-form";

export type { ImportOutcome } from "./f14/outcome";

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the import made, where to go, what to say and how to undo it. */
  onImported: (outcome: ImportOutcome) => void;
}

type Step = "pick" | "single" | "arrange";
const PHONE_MAX = 640;
/** F17: step 2 is a 1340 × 840 workspace (the mind map and its inspector); step 1 stays 880 wide. */
const ARRANGE_SIZE = "sm:max-w-[min(94vw,83.75rem)]! sm:h-[min(92dvh,52.5rem)]!";

/** The pool's conversations as sessions: the pick order (checked ones first, in the order checked) and the times set. */
function sessionsOf(entries: readonly PoolEntry[], picked: readonly string[], manual: Readonly<Record<string, string | null>>): TimelineSession[] {
  return entries.map((entry, index) => {
    const at = picked.indexOf(entry.key);
    return { key: entry.key, conversation: entry.conversation, source: entry.source, fileName: entry.fileName, pickOrder: at >= 0 ? at : picked.length + index, manualTime: manual[entry.key] ?? null };
  });
}

/** Picks, query and times of step 1; a conversation alone in the pool is checked unless it was imported before. */
function usePicks(entries: readonly PoolEntry[], duplicates: ReadonlyMap<string, DuplicateOf>) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState<Readonly<Record<string, string | null>>>({});
  const auto = useRef(new Set<string>());
  const only = entries.length === 1 ? entries[0]!.key : null;
  useEffect(() => {
    if (!only || auto.current.has(only) || duplicates.has(only)) return;
    auto.current.add(only);
    setPicked((current) => (current.includes(only) ? current : [...current, only]));
  }, [only, duplicates]);
  const present = new Set(entries.map((entry) => entry.key));
  return {
    picked: picked.filter((key) => present.has(key)),
    query,
    manual,
    setQuery,
    toggle: (key: string) => setPicked((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key])),
    pickAll: (keys: readonly string[]) => setPicked((current) => [...current, ...keys.filter((key) => !current.includes(key))]),
    setTime: (key: string, value: string | null) => setManual((current) => ({ ...current, [key]: value })),
  };
}

function Body({ onOpenChange, onImported }: Omit<ImportDialogProps, "open">) {
  const t = useF14T();
  const u = useUndoWords();
  const { locale } = useUiLocale();
  const deleting = useDeleteLine();
  const touch = useViewportWidth() < PHONE_MAX;
  const active = useLines();
  const archived = useLines({ archived: true });
  // B18.1: every folder and tag of the tenant for the pickers (the loaded conversations until it is read).
  const organization = useLineOrganization().data;
  const lines = useMemo(() => [...(active.data?.lines ?? []), ...(archived.data?.lines ?? [])], [active.data, archived.data]);
  const pool = useImportPool();
  const [tab, setTab] = useState<SourceTab>("file");
  const [step, setStep] = useState<Step>("pick");
  // Step 2 stays mounted once opened (hidden on step 1), so going back keeps its order, roles and cards.
  const [arranged, setArranged] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  // A new step replaces the control that had focus: its heading takes it and says where we are.
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);
  const importedIds = useMemo(() => readImportedIds(), []);
  const plainSessions = useMemo(() => sessionsOf(pool.entries, [], {}), [pool.entries]);
  const duplicates = useMemo(
    () =>
      new Map(
        plainSessions.flatMap((session) => {
          const duplicate = findDuplicate(session, lines, importedIds);
          return duplicate ? [[session.key, duplicate] as const] : [];
        }),
      ),
    [plainSessions, lines, importedIds],
  );
  const picks = usePicks(pool.entries, duplicates);
  const sessions = useMemo(() => sessionsOf(pool.entries, picks.picked, picks.manual), [pool.entries, picks.picked, picks.manual]);
  const chosen = useMemo(() => sessions.filter((session) => picks.picked.includes(session.key)), [sessions, picks.picked]);
  const single = pool.entries.find((entry) => entry.key === picks.picked[0]) ?? null;
  const folders = knownFolderNames(organization, lines);
  const known = knownTagCounts(organization, lines);
  const done = (outcome: ImportOutcome) => {
    onOpenChange(false);
    onImported(outcome);
  };
  const singleDone = (result: ImportConversationResult, decompose: boolean) => {
    if (single) rememberImported([single]);
    done({
      lineIds: [result.line.id],
      focusLineId: result.line.id,
      messageCount: result.messageCount,
      decompose,
      assembled: false,
      toast: t("done.toastSingle", { title: result.line.title }),
      undo: undoOf(deleting.mutateAsync, [result.line.id], u),
    });
  };
  return (
    <DialogContent width="split" padded={false} title={t("import.title")} description={t("import.sub")} className={step === "arrange" ? ARRANGE_SIZE : "sm:h-[calc(100dvh-4rem)]!"}>
      <div className="flex h-full min-h-0 flex-col">
        <div className={touch ? "px-4 pt-2" : "px-5 pt-3"}>
          <h3 ref={heading} tabIndex={-1} className="sr-only">
            {t("import.stepHeading", { n: step === "arrange" ? 2 : 1, label: step === "arrange" ? t("import.step2") : t("import.step1") })}
          </h3>
          <ImportStepper step={step === "arrange" ? 2 : 1} touch={touch} onBack={() => setStep("pick")} />
        </div>
        {step === "pick" && (
          <PickStep
            pool={pool}
            tab={tab}
            onTab={setTab}
            sessions={sessions}
            duplicates={duplicates}
            picked={picks.picked}
            query={picks.query}
            touch={touch}
            locale={locale}
            onQuery={picks.setQuery}
            onToggle={picks.toggle}
            onPickAll={picks.pickAll}
            onSetTime={picks.setTime}
            onCancel={() => onOpenChange(false)}
            onQuick={() => setStep("single")}
            onNext={() => {
              setArranged(true);
              setStep("arrange");
            }}
          />
        )}
        {step === "single" && single && (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4 [&>*]:shrink-0">
            <ImportForm key={single.key} parsed={single.parsed} conversation={single.conversation} folders={folders} known={known} touch={touch} onCancel={() => setStep("pick")} onImported={singleDone} />
          </div>
        )}
        {arranged && chosen.length > 0 && (
          <div hidden={step !== "arrange"} className="flex min-h-0 flex-1 flex-col">
            <AssemblyStep sessions={chosen} folders={folders} known={known} touch={touch} locale={locale} onSetTime={picks.setTime} onBack={() => setStep("pick")} onDone={done} />
          </div>
        )}
      </div>
    </DialogContent>
  );
}

export default function ImportDialog({ open, onOpenChange, onImported }: ImportDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <Body onOpenChange={onOpenChange} onImported={onImported} />}
    </Dialog>
  );
}
