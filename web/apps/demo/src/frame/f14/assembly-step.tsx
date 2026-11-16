/**
 * F14 step 2 of the import dialog: S2 (the sessions oldest first, each with
 * its mini expand; the left 372 column) and S3 (how they are assembled and
 * the preview; the right column), with S4's summary bar under both. Phones
 * get two tabs, 時間序 and 結構圖.
 * F16.1: the multi-select and drag state shared by both columns, the role
 * drop zones over the preview (desktop), both columns scrolling while a drag
 * nears their edge, and a status line for what a drop or batch action did.
 * F16.2: 「✨ AI 智慧分析支線樹」 on top (ai-tree-bar.tsx): the analysis gives
 * the assembly its sessions (a conversation's rounds, when split) and its
 * arrangement; the preview's nodes read it through AiTreeContext.
 * F17: a second view of the same assembly, the mind map workspace (canvas and
 * node inspector, mindmap-workspace.tsx), switched to from the AiTreeBar or
 * the list's entry; the step opens on the list as before.
 */
import { isFeatureOn, type TagCount, type TimelineSession } from "@tangent/client";
import { Tab, Tabs, TabsList, TabsPanel, useCapabilities, useReadOnly, useTangentClient } from "@tangent/react";
import { ClockArrowUp, Info, Network, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { focusIfLost } from "./ai-node-panel";
import { AiTreeBar } from "./ai-tree-bar";
import { AiTreeContext } from "./ai-tree-context";
import { BottomNotices, TopNotices } from "./assembly-notices";
import { BlueprintPreview } from "./blueprint-preview";
import { RoleDropZones } from "./drop-zones";
import { useF14T } from "./f14-messages";
import { ModePicker } from "./mode-picker";
import { folderOf, OrganizeFields } from "./organize-fields";
import type { ImportOutcome } from "./outcome";
import { SummaryBar } from "./summary-bar";
import { refocus, roleButtonOf } from "./card-handlers";
import { TimelineColumn } from "./timeline-column";
import { useAiSessions, useAiTree } from "./use-ai-tree";
import { useAssembly, type Assembly, type StepStatus as StepStatusValue } from "./use-assembly";
import { AssemblyDndContext, useAssemblyDrag } from "./use-assembly-drag";
import { useAssemblyImport } from "./use-assembly-import";
import { useDragAutoscroll } from "./use-drag-autoscroll";
import { useSessionSelection } from "./use-session-selection";
import { MindMapWorkspace } from "./mindmap-workspace";
import { MindMapEntry, type StepView } from "./view-switch";

/** How long the status line stays after an action (ms). */
const STATUS_MS = 8000;

export interface AssemblyStepProps {
  sessions: readonly TimelineSession[];
  folders: readonly string[];
  known: readonly TagCount[];
  touch: boolean;
  locale: string;
  onSetTime: (key: string, manualTime: string | null) => void;
  onBack: () => void;
  onDone: (outcome: ImportOutcome) => void;
}

interface StructureColumnProps {
  assembly: Assembly;
  relations: boolean;
  touch: boolean;
  folders: readonly string[];
  known: readonly TagCount[];
  notices: { bottom: ReactNode };
  onOpenMap: () => void;
}

function StructureColumn({ assembly, relations, touch, folders, known, notices, onOpenMap }: StructureColumnProps) {
  const t = useF14T();
  const [organizing, setOrganizing] = useState(false);
  const { blueprint, byKey, ordered } = assembly;
  const titleOf = (key: string) => byKey.get(key)?.conversation.title || t("import.untitled");
  const firstChapter = blueprint.nodes.find((node) => node.role === "chapter");
  const fields = (
    <OrganizeFields value={assembly.organize} onChange={assembly.setOrganize} folders={folders} known={known} withTitle={blueprint.mode !== "batch"} titlePlaceholder={firstChapter ? titleOf(firstChapter.key) : ""} touch={touch} />
  );
  return (
    <section aria-label={t("assembly.title")} className="flex min-h-0 flex-col gap-2.5">
      {!touch && (
        <header className="flex items-center gap-2">
          <Network aria-hidden className="size-4 text-tg-muted" />
          <h3 className="m-0 text-tg-sm font-semibold text-tg-foreground-strong">{t("assembly.title")}</h3>
        </header>
      )}
      {!touch && <RoleDropZones />}
      <MindMapEntry onOpen={onOpenMap} touch={touch} />
      <ModePicker mode={blueprint.mode} recommendTree={blueprint.recommendTree} relations={relations} touch={touch} onMode={assembly.setMode} />
      <TopNotices blueprint={blueprint} sessions={ordered} titleOf={titleOf} onUseTree={() => assembly.setMode("tree")} />
      {blueprint.mode !== "batch" && (
        <div className="flex flex-col gap-2">
          <button type="button" aria-expanded={organizing} onClick={() => setOrganizing((open) => !open)} className="self-end rounded-tg-sm px-1 text-tg-xs font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
            {organizing ? t("assembly.folderTagsDone") : t("assembly.folderTags")}
          </button>
          {organizing && fields}
        </div>
      )}
      <BlueprintPreview
        blueprint={blueprint}
        sessions={byKey}
        relations={relations}
        touch={touch}
        attachOptions={assembly.attachOptions}
        invalid={new Set(blueprint.problems.flatMap((problem) => (problem.kind === "invalidAttach" ? [problem.key] : [])))}
        handlers={{
          onRole: (key, role) => {
            assembly.setRole(key, role);
            // A node that moves between the tree and the separate list remounts: its role button takes focus back.
            refocus(roleButtonOf(key, "preview"));
          },
          onAttach: assembly.setAttach,
          onMove: assembly.move,
          onConclusion: assembly.setConclusion,
          // The pressed control (or the merged-away node) is gone: the kept node's role button takes focus.
          onMergeUp: (key) => {
            const above = ordered[ordered.findIndex((session) => session.key === key) - 1];
            if (above && assembly.mergeSessions([above.key, key], above.key)) refocus(roleButtonOf(above.key, "preview"));
          },
          onUnmerge: (key) => {
            assembly.unmergeSession(key);
            refocus(roleButtonOf(key, "preview"));
          },
          mergedCountOf: assembly.mergedCountOf,
        }}
        folder={folderOf(assembly.organize)}
        tags={assembly.organize.tags}
        organize={blueprint.mode === "batch" && organizing ? fields : null}
        onOrganize={() => setOrganizing((open) => !open)}
      />
      {notices.bottom}
    </section>
  );
}

export function AssemblyStep({ sessions, folders, known, touch, locale, onSetTime, onBack, onDone }: AssemblyStepProps) {
  const t = useF14T();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const relations = isFeatureOn(capabilities.data, "relations") && !readOnly;
  const client = useTangentClient();
  const ai = useAiSessions(sessions);
  // An expanded round's time is the step's own; the dialog keeps the picked sessions' times.
  const assembly = useAssembly({ sessions: ai.sessions, folders, relations, onSetTime: (key, time) => ai.setRoundTime(key, time) || onSetTime(key, time) });
  const tree = useAiTree({ ai, assembly, picked: sessions, client });
  const sender = useAssemblyImport({ blueprint: assembly.blueprint, partsOf: assembly.partsOf, relate: relations, onDone });
  const selection = useSessionSelection(assembly.ordered.map((session) => session.key));
  const dnd = useAssemblyDrag(assembly, selection);
  const left = useDragAutoscroll<HTMLDivElement>();
  const right = useDragAutoscroll<HTMLDivElement>();
  const problemsId = useId();
  const [tab, setTab] = useState("time");
  // F17: the list (as before) or the mind map, and the map without its inspector.
  const [view, setView] = useState<StepView>("list");
  const [full, setFull] = useState(false);
  const showView = (next: StepView) => {
    setView(next);
    if (next === "list") setFull(false);
    if (next === "mindmap" && touch) setTab("struct");
    // The list's checked sessions are not shown on the map: a node dragged there moves alone.
    if (next === "mindmap") selection.clear();
    // An entry that opened the map is gone with the list: the map's current node takes focus.
    if (next === "mindmap") focusIfLost('[data-tg-mindmap-canvas] [role="treeitem"][tabindex="0"]');
  };
  // Phones: a finished analysis shows the tree it drew.
  const plan = tree.analysis?.plan;
  useEffect(() => {
    if (plan && touch) setTab("struct");
  }, [plan, touch]);
  const titleOf = (key: string) => assembly.byKey.get(key)?.conversation.title || t("import.untitled");
  const bottom = (
    <BottomNotices
      blueprint={assembly.blueprint}
      titleOf={titleOf}
      problemsId={problemsId}
      failure={sender.failure}
      busy={sender.busy}
      onRetry={sender.retry}
      onRetryOne={() => void sender.retryOne()}
      onFinish={sender.finishPartial}
    />
  );
  const partial = sender.failure?.kind === "partial";
  const blocked = assembly.blueprint.problems.length > 0 || partial;
  // Leaving after a partial failure (Esc, ×) still hands over what was made, with its undo.
  const pending = useRef<() => void>(() => undefined);
  useEffect(() => {
    pending.current = partial ? sender.finishPartial : () => undefined;
  }, [partial, sender.finishPartial]);
  useEffect(() => () => pending.current(), []);
  const timeline = <TimelineColumn assembly={assembly} dnd={dnd} picked={sessions.length} relations={relations} touch={touch} locale={locale} />;
  const mapped = view === "mindmap";
  // On the map, the main line's own settings (the list's mode, notices, title, folder and tags) are the root's details.
  const mainLine = mapped ? (
    <div className="flex flex-col gap-2.5">
      <ModePicker mode={assembly.blueprint.mode} recommendTree={assembly.blueprint.recommendTree} relations={relations} touch={touch} onMode={assembly.setMode} />
      <TopNotices blueprint={assembly.blueprint} sessions={assembly.ordered} titleOf={titleOf} onUseTree={() => assembly.setMode("tree")} />
      <OrganizeFields value={assembly.organize} onChange={assembly.setOrganize} folders={folders} known={known} withTitle={assembly.blueprint.mode !== "batch"} titlePlaceholder="" touch={touch} />
    </div>
  ) : null;
  const structure = mapped ? (
    <MindMapWorkspace assembly={assembly} view={tree.view} touch={touch} full={full} onFull={setFull} mainLine={mainLine} />
  ) : (
    <StructureColumn assembly={assembly} relations={relations} touch={touch} folders={folders} known={known} notices={{ bottom }} onOpenMap={() => showView("mindmap")} />
  );
  return (
    <AssemblyDndContext.Provider value={dnd}>
    <AiTreeContext.Provider value={tree.view}>
    <div className="flex min-h-0 flex-1 flex-col">
      <AiTreeBar tree={tree} blueprint={assembly.blueprint} mergedCountOf={assembly.mergedCountOf} touch={touch} views={{ view, onView: showView, full, onFull: setFull }} />
      <StepStatus status={assembly.status} touch={touch} onClear={assembly.clearStatus} />
      {touch ? (
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label={t("import.step2Short")} className="h-11 shrink-0 border-b border-tg-border px-2 [&>*]:flex-1 [&>*]:justify-center">
            <Tab value="time">
              <ClockArrowUp aria-hidden className="size-4" />
              {t("import.tabTime")} {sessions.length}
            </Tab>
            <Tab value="struct">
              <Network aria-hidden className="size-4" />
              {t("import.tabStruct")}
            </Tab>
          </TabsList>
          <TabsPanel value="time" keepMounted className="overflow-auto px-4 py-3">
            {timeline}
          </TabsPanel>
          <TabsPanel value="struct" keepMounted className={mapped ? "flex flex-col overflow-auto" : "overflow-auto px-4 py-3"}>
            {structure}
            {mapped && bottom}
          </TabsPanel>
        </Tabs>
      ) : mapped ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          {structure}
          {bottom}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[372px_minmax(0,1fr)] grid-rows-1 gap-5 px-5 py-4">
          <div ref={left.ref} onDragOver={left.onDragOver} className="min-h-0 overflow-auto pr-1">
            {timeline}
          </div>
          <div ref={right.ref} onDragOver={right.onDragOver} className="min-h-0 overflow-auto pr-1">
            {structure}
          </div>
        </div>
      )}
      <SummaryBar
        blueprint={assembly.blueprint}
        folder={folderOf(assembly.organize)}
        tags={assembly.organize.tags.length}
        touch={touch}
        blocked={blocked}
        problemsId={assembly.blueprint.problems.length > 0 ? problemsId : undefined}
        importing={sender.progress}
        backDisabled={partial}
        onBack={onBack}
        onImport={(decompose) => void sender.submit(decompose)}
      />
    </div>
    </AiTreeContext.Provider>
    </AssemblyDndContext.Provider>
  );
}

/** What the last drop or batch action did (a mode switched to the tree is said here); it goes after a while. */
function StepStatus({ status, touch, onClear }: { status: StepStatusValue; touch: boolean; onClear: () => void }) {
  const t = useF14T();
  const { text, id } = status;
  // Every action restarts the timer, also one that says the same words again.
  useEffect(() => {
    if (!text) return;
    const timer = window.setTimeout(onClear, STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [text, id, onClear]);
  return (
    <div role="status" data-tg-step-status="" className={text ? (touch ? "px-4 pt-2" : "px-5 pt-2") : "sr-only"}>
      {text && (
        <p key={id} className="m-0 flex items-center gap-2 rounded-tg-sm border border-tg-border bg-tg-surface-sunken px-2.5 py-1.5 text-tg-xs text-tg-foreground">
          <Info aria-hidden className="size-3.5 shrink-0 text-tg-primary-text" />
          <span className="flex-1">{text}</span>
          <button type="button" aria-label={t("f161.dismiss")} onClick={onClear} className="grid size-6 shrink-0 place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:size-11">
            <X aria-hidden className="size-3.5" />
          </button>
        </p>
      )}
    </div>
  );
}
