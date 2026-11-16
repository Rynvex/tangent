import { branchTitle, focusScope, isFeatureOn, MAP_ROOT_KEY, noteCountsByNode, type Chapter } from "@tangent/client";
import {
  BranchMap,
  Button,
  NodePanel,
  SidePanel,
  useBranches,
  useCapabilities,
  useEscapeLayer,
  useFocusT,
  useGroupForm,
  useMapFisheye,
  useMainChapters,
  useMapGroups,
  useMapRelationsData,
  useMapTags,
  useMemos,
  useMessages,
  useNotes,
  type NodePanelAction,
  type NodePanelHandle,
} from "@tangent/react";
import { Crosshair, PanelLeftClose, PanelLeftOpen, ScanSearch, X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { useForkHighlight } from "./fork-highlight";
import { checkFlow, continueFlow } from "./memo-flows";
import { PANEL_BOTTOM_SHARE, PANEL_GAP_PX, PANEL_WIDTH_PX } from "./focus-split";

/** Where the node panel sits: beside the map (≥ 640), rising from its bottom, or a sheet (tabs). */
export type PanelPlace = "float" | "bottom" | "sheet";

export interface FocusMapProps {
  rootLineId: string;
  /** The line on screen. */
  lineId: string;
  place: PanelPlace;
  follow: boolean;
  onFollowChange: (on: boolean) => void;
  notesLayer: boolean;
  onNotesLayerChange: (on: boolean) => void;
  /** 收合對話 (split only): the chat at its narrowest, and back. */
  chat?: { collapsed: boolean; onToggle: () => void };
  /** Enters a line (the host shows the chat on narrow frames). */
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  onBringIn: (text: string) => void;
  onShowAllNotes: () => void;
}

const PILL =
  "inline-flex h-6.5 items-center gap-1 rounded-tg-full border px-2.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11 [&_svg]:size-3";
const PILL_ON = "border-tg-primary bg-tg-primary-soft text-tg-primary-text";
const PILL_OFF = "border-tg-border-strong text-tg-muted hover:text-tg-foreground";

function Pill({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick} className={`${PILL} ${on ? PILL_ON : PILL_OFF}`}>
      {children}
    </button>
  );
}

/** The panel's buttons open the frame's existing dialogs. */
function flowFor(action: NodePanelAction, lineId: string, lastMessageId: string | null): BranchFlow | null {
  switch (action) {
    case "bringBack":
      return { kind: "review", lineId };
    case "discard":
      return { kind: "discard", lineId };
    case "promote":
      return { kind: "promote", lineId };
    case "spinoff":
      return { kind: "spinoff", lineId, atMessageId: lastMessageId ?? "" };
    case "keepAside":
      return { kind: "asideNote", lineId };
    case "deleteBranch":
      return { kind: "deleteBranch", lineId };
    case "branch":
      return lastMessageId ? { kind: "open", lineId, request: { anchorMessageId: lastMessageId } } : null;
  }
}

/** Typing in a field never runs the map's letter keys. */
const isTyping = (target: EventTarget) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Focus mode's map (FOCUS_MODE.md §6–§8): the tree beside the chat, kept
 * in step with it. A click chooses a node and opens its panel; following,
 * a focused subtree and the notes marks are toolbar switches.
 */
export function FocusMap(props: FocusMapProps) {
  const { rootLineId, lineId, place, follow, onFollowChange, notesLayer, onNotesLayerChange, chat, navigate, onFlow, onBringIn, onShowAllNotes } = props;
  const t = useFocusT();
  const capabilities = useCapabilities();
  const branches = useBranches(rootLineId, true);
  const main = useMessages(rootLineId);
  // The chat's messages: the fork points re-observed when they change.
  const current = useMessages(lineId);
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const notes = useNotes(rootLineId, notesOn && notesLayer);
  const memoOn = isFeatureOn(capabilities.data, "memo");
  const memos = useMemos(rootLineId, memoOn && notesLayer);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [focusLine, setFocusLine] = useState<string | null>(null);
  const panel = useRef<NodePanelHandle>(null);
  const list = useMemo(() => branches.data?.branches ?? [], [branches.data]);
  const relations = useMapRelationsData(rootLineId);
  const fisheye = useMapFisheye(rootLineId, lineId);
  const form = useGroupForm(rootLineId, (result) => result.lineId && navigate(result.lineId));
  const groups = useMapGroups(rootLineId, (mode, members) => form.open({ mode, members }));
  const tags = useMapTags();
  // F11 §3: the main line's stages under its node (the chapters feature).
  const chapters = useMainChapters(rootLineId);
  // Only beside the chat, while following (§6.1).
  const forkGlow = useForkHighlight(lineId, list, follow && !paused && place !== "sheet", current.data);
  // Esc closes the panel before it goes back a level (§10).
  useEscapeLayer(selected !== null && place !== "sheet", () => setSelected(null));

  const counts = useMemo(() => (notesOn && notesLayer && notes.data ? noteCountsByNode(notes.data.notes, rootLineId, list) : undefined), [notesOn, notesLayer, notes.data, rootLineId, list]);
  // Memos per node (B13), in the same mark; memos whose node is gone have no node to sit on.
  const memoCounts = useMemo(() => {
    if (!memoOn || !notesLayer || !memos.data) return undefined;
    const known = new Set(list.map((branch) => branch.lineId));
    const byNode = new Map<string, number>();
    for (const memo of memos.data.memos) {
      const key = memo.lineId === rootLineId ? MAP_ROOT_KEY : memo.lineId;
      if (key !== MAP_ROOT_KEY && !known.has(key)) continue;
      byNode.set(key, (byNode.get(key) ?? 0) + 1);
    }
    return byNode;
  }, [memoOn, notesLayer, memos.data, rootLineId, list]);
  const keyOf = (id: string) => (id === rootLineId ? MAP_ROOT_KEY : id);
  const titleOf = (id: string) => {
    const branch = list.find((item) => item.lineId === id);
    return branch ? branchTitle(branch, t) : t("panel.main");
  };
  const scope = useMemo(() => (focusLine ? focusScope(keyOf(focusLine), list) : null), [focusLine, list]); // eslint-disable-line react-hooks/exhaustive-deps
  const outside = scope !== null && !scope.has(keyOf(lineId));
  const mainCount = (main.data?.messages ?? []).filter((message) => message.kind === "chat" && message.role !== "system").length;

  if (branches.isError) {
    return (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-tg-sm text-tg-muted">
        {t("map.loadFailed")}
        <Button size="sm" onClick={() => void branches.refetch()}>
          {t("map.retry")}
        </Button>
      </div>
    );
  }

  const following = follow && !paused;
  const narrow = place === "sheet";
  const toolbar = (
    <>
      {follow && paused ? (
        <span className="inline-flex items-center gap-1.5 text-tg-xs text-tg-muted">
          {t("map.followPaused")}
          <button type="button" onClick={() => setPaused(false)} className={`${PILL} ${PILL_OFF}`}>
            <Crosshair aria-hidden />
            {t("map.backHere")}
          </button>
        </span>
      ) : (
        <Pill
          on={following}
          onClick={() => {
            setPaused(false);
            onFollowChange(!follow);
          }}
        >
          <Crosshair aria-hidden />
          {t("map.follow")}
        </Pill>
      )}
      <Pill on={focusLine !== null} title={t("map.focusNote")} onClick={() => setFocusLine(focusLine ? null : (selected ?? lineId))}>
        <ScanSearch aria-hidden />
        {focusLine ? t("map.focusOn", { title: titleOf(focusLine) }) : t("map.focusSubtree")}
      </Pill>
      {focusLine && (
        <button type="button" aria-label={t("map.focusClear")} onClick={() => setFocusLine(null)} className="grid size-6.5 place-items-center rounded-tg-full text-tg-muted hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring [&_svg]:size-3">
          <X aria-hidden />
        </button>
      )}
      {outside && (
        <span role="status" className="inline-flex items-center gap-1.5 text-tg-xs text-tg-warning">
          {t("map.outsideFocus")}
          <button type="button" onClick={() => setFocusLine(lineId)} className={`${PILL} ${PILL_OFF}`}>
            {t("map.focusHere")}
          </button>
        </span>
      )}
      {chat && (
        <Pill on={chat.collapsed} onClick={chat.onToggle}>
          {chat.collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          {chat.collapsed ? t("map.expandChat") : t("map.collapseChat")}
        </Pill>
      )}
    </>
  );

  const enter = (target: string) => navigate(target);
  const nodePanel = selected ? (
    <div data-tg-focus-region="panel" className="contents">
    <NodePanel
      ref={panel}
      key={selected}
      rootLineId={rootLineId}
      lineId={selected}
      currentLineId={lineId}
      // The sheet has its own ✕.
      {...(place === "sheet" ? {} : { onClose: () => setSelected(null) })}
      onGo={(target, messageId) => navigate(target, messageId)}
      onAction={(action, at) => {
        const flow = flowFor(action, at.lineId, at.lastMessageId);
        if (flow) onFlow(flow);
      }}
      onBringIn={onBringIn}
      onContinue={(request) => onFlow(continueFlow(request))}
      // F8 S10: the check goes in the new branch's composer, unsent (decision #9).
      onCheckUnderstanding={(request) => onFlow(checkFlow(request))}
      onGoToNote={() => onShowAllNotes()}
      onGoToRelation={(relation) => navigate(relation.fromLineId, relation.fromMessageId || undefined)}
      onShowAllNotes={onShowAllNotes}
    />
    </div>
  ) : null;
  const overlay =
    nodePanel && place === "float" ? (
      <div className="absolute top-0 right-0 bottom-0 z-10 overflow-y-auto rounded-tg border border-tg-border bg-tg-surface-raised shadow-tg-overlay" style={{ width: PANEL_WIDTH_PX }}>
        {nodePanel}
      </div>
    ) : nodePanel && place === "bottom" ? (
      <div className="absolute inset-x-0 bottom-0 z-10 overflow-y-auto rounded-t-tg border border-tg-border bg-tg-surface-raised shadow-tg-overlay" style={{ height: `${PANEL_BOTTOM_SHARE * 100}%` }}>
        {nodePanel}
      </div>
    ) : null;

  // F2 renames and N writes a note on the chosen node (§10); Enter is the node's own key.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Keys bubble through portals: a menu's type-ahead or a dialog's button is not the map.
    if (!selected || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "F2") panel.current?.editTitle();
    else if (event.key === "n" || event.key === "N") panel.current?.addNote();
    else return;
    event.preventDefault();
  };

  return (
    <section aria-label={t("focus.mapRegion")} data-tg-focus-region="map" onKeyDown={onKeyDown} className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
      <BranchMap
        key={rootLineId}
        branches={list}
        rootLineId={rootLineId}
        currentLineId={lineId}
        mainCount={mainCount}
        showLeaves={isFeatureOn(capabilities.data, "leaf")}
        onEnter={enter}
        onSelect={(target) => setSelected(target === selected ? null : target)}
        selectedLineId={selected}
        focusLineId={focusLine}
        follow={following}
        onManualMove={() => follow && setPaused(true)}
        coveredRight={overlay && place === "float" ? PANEL_WIDTH_PX + PANEL_GAP_PX : 0}
        coveredBottomShare={overlay && place === "bottom" ? PANEL_BOTTOM_SHARE : 0}
        toolbar={toolbar}
        overlay={overlay}
        highlighted={forkGlow}
        {...(counts ? { noteCounts: counts } : {})}
        {...(memoCounts ? { memoCounts } : {})}
        {...((notesOn || memoOn) && !narrow ? { extraLayers: [{ id: "notes" as const, on: notesLayer, onChange: onNotesLayerChange, label: t("map.notesLayer") }] } : {})}
        // On narrow frames the map only pans, zooms and opens the panel: no layers, relations or multi-select (§4.1, S13).
        {...(relations && !narrow ? { relations } : {})}
        {...(fisheye && !narrow ? { fisheye } : {})}
        {...(groups && !narrow ? { groups } : {})}
        {...(tags && !narrow ? { tags } : {})}
        {...(chapters ? { chapters, onGoToChapter: (chapter: Chapter) => navigate(rootLineId, chapter.startMessageId) } : {})}
      />
      {place === "sheet" && (
        <SidePanel mode="sheet" open={selected !== null} onOpenChange={(open) => !open && setSelected(null)} label={t("focus.panelRegion")}>
          <div className="min-h-0 overflow-y-auto">{nodePanel}</div>
        </SidePanel>
      )}
      {/* The panel does not take focus; its node's name is read out instead (§10). */}
      <span className="sr-only" aria-live="polite">
        {selected ? titleOf(selected) : ""}
      </span>
      {form.dialog}
    </section>
  );
}
