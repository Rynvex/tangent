import { activeCount, isFeatureOn } from "@tangent/client";
import { LazyGlossaryPanel, LazyMemoryFooter, NotesPanel, SegmentedControl, useCapabilities, useFocusT, useGlossaryT, useHiddenTermIds, useLine, useMemos, useNotes, useReadOnly, useTerms, type GlossaryToast, type NodeMemosHandle } from "@tangent/react";
import { useMemo, useRef, type KeyboardEvent } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { LineMemos } from "./line-memos";

/** Which part of 紀要｜名詞表｜備忘 shows; the shell holds it so 記成備忘 can open 備忘 and a known term 名詞表. */
export type NotesView = "notes" | "terms" | "memos";

export interface NotesSideProps {
  rootLineId: string;
  lineId: string;
  navigate: Navigate;
  onOpenLibrary: () => void;
  view: NotesView;
  onViewChange: (view: NotesView) => void;
  /** 從這裡繼續談… and 請 AI 檢驗理解… open the frame's branch dialog. */
  onFlow: (flow: BranchFlow) => void;
  /** F19: the frame's toast (a deleted term's 復原). */
  toast?: GlossaryToast;
  /** F19: a term 名詞表 shows open and in view. */
  focusTerm?: { termId: string; n: number } | null;
}

/** Typing in a field never runs N. */
const isTyping = (target: EventTarget) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

interface KindSwitchProps {
  rootLineId: string;
  lineId: string;
  /** The parts whose feature is on, in order. */
  kinds: readonly NotesView[];
  view: NotesView;
  onViewChange: (view: NotesView) => void;
}

/** 紀要｜名詞表｜備忘 with each part's count: the tree's active notes, its terms, the memos of the line on screen. */
function KindSwitch({ rootLineId, lineId, kinds, view, onViewChange }: KindSwitchProps) {
  const t = useFocusT();
  const g = useGlossaryT();
  const has = (kind: NotesView) => kinds.includes(kind);
  const notes = useNotes(rootLineId, has("notes"));
  const memos = useMemos(rootLineId, has("memos"));
  const terms = useTerms(rootLineId, has("terms"));
  const hidden = useHiddenTermIds();
  const noteCount = notes.data ? activeCount(notes.data.notes) : 0;
  const memoCount = useMemo(() => (memos.data?.memos ?? []).filter((memo) => memo.lineId === lineId).length, [memos.data, lineId]);
  const termCount = useMemo(() => (terms.data?.terms ?? []).filter((term) => !hidden.has(term.id)).length, [terms.data, hidden]);
  const labels: Record<NotesView, string> = { notes: t("notes.sideNotes", { n: noteCount }), terms: g("glossary.sideTerms", { n: termCount }), memos: t("notes.sideMemos", { n: memoCount }) };
  return (
    <div className="shrink-0 px-3 pt-3">
      <SegmentedControl label={has("terms") ? g("glossary.sideKinds") : t("notes.sideKinds")} options={kinds.map((kind) => ({ value: kind, label: labels[kind] }))} value={view} onValueChange={onViewChange} />
    </div>
  );
}

const noToast: GlossaryToast = () => undefined;
/** What shows when the part asked for is off, in this order. */
const FALLBACK: readonly NotesView[] = ["notes", "memos", "terms"];

/**
 * The side panel's 紀要 (A9), loaded with the tab: its source links switch
 * lines through the demo's navigation. With memos on (F10) or the glossary
 * on (F19), 紀要｜名詞表｜備忘 at the top, only the parts whose feature is
 * on (one part alone has no switch), and N writes a memo while the panel
 * has focus. Under it, set apart, the memory the line's next turn brings in
 * from other conversations (D1).
 */
export function NotesSide({ rootLineId, lineId, navigate, onOpenLibrary, view, onViewChange, onFlow, toast = noToast, focusTerm = null }: NotesSideProps) {
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const root = useLine(rootLineId);
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const memoOn = isFeatureOn(capabilities.data, "memo");
  const glossaryOn = isFeatureOn(capabilities.data, "glossary");
  const kinds = useMemo<NotesView[]>(() => [...(notesOn ? ["notes" as const] : []), ...(glossaryOn ? ["terms" as const] : []), ...(memoOn ? ["memos" as const] : [])], [notesOn, glossaryOn, memoOn]);
  // The part asked for while its feature is on; else 紀要, else 備忘 (F10: the tab reads 備忘 then), else 名詞表.
  const shown: NotesView = kinds.includes(view) ? view : (FALLBACK.find((kind) => kinds.includes(kind)) ?? "notes");
  const memos = useRef<NodeMemosHandle>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys bubble through portals: a memo's menu or a dialog is not the panel.
    if (!memoOn || readOnly || (event.key !== "n" && event.key !== "N") || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    if (shown === "memos") {
      memos.current?.add();
      return;
    }
    onViewChange("memos");
    requestAnimationFrame(() => memos.current?.add());
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {kinds.length > 1 && <KindSwitch rootLineId={rootLineId} lineId={lineId} kinds={kinds} view={shown} onViewChange={onViewChange} />}
      {shown === "memos" ? (
        <LineMemos ref={memos} rootLineId={rootLineId} lineId={lineId} notesOn={notesOn} navigate={navigate} onFlow={onFlow} />
      ) : shown === "terms" ? (
        <LazyGlossaryPanel rootLineId={rootLineId} readOnly={readOnly || Boolean(root.data?.archivedAt)} onGoToSource={(target, messageId) => navigate(target, messageId)} toast={toast} focus={focusTerm} />
      ) : (
        <NotesPanel rootLineId={rootLineId} lineId={lineId} onGoToSource={(target, messageId) => navigate(target, messageId)} />
      )}
      {isFeatureOn(capabilities.data, "memory") && <LazyMemoryFooter lineId={lineId} onOpenLibrary={onOpenLibrary} className="mx-3 mb-3 shrink-0" />}
    </div>
  );
}
