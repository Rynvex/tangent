import { branchTitle, inboxCount, isFeatureOn, modelChoices, type BranchView } from "@tangent/client";
import type { BranchDeleteRequest } from "./frame/branch-delete-host";
import {
  LazyRegion,
  RangeHighlight,
  SidePanel,
  SideTabs,
  TangentRoot,
  useBranches,
  useCapabilities,
  useCommand,
  useLine,
  useLines,
  useReadOnly,
  useTangentEvents,
  useUiT,
  type SideTabId,
  type StructureView,
  type TangentTheme,
} from "@tangent/react";
import { lazy, useCallback, useRef, useState } from "react";
import type { BranchFlow } from "./frame/branch-flows";
import { bannerFor, Header, pathItems } from "./frame/center";
import { ConversationView } from "./frame/conversation-view";
import { nextConversation, useConversationDeletion } from "./frame/delete-host";
import { EmbedFrame } from "./frame/embed-frame";
import { DialogSlot, SearchSlot, useF8Frame } from "./frame/f8-frame";
import { useF13Frame } from "./frame/f13-frame";
import { DecomposeSlot, ImportedSlot, ImportSlot } from "./frame/f13-slots";
import type { FocusTab } from "./frame/focus-pane";
import { loadFocusPrefs, saveFocusPrefs, type FocusPrefs } from "./frame/focus-state";
import { useMemoSaver } from "./frame/memo-host";
import { useNewConversation } from "./frame/model-pill";
import { arrangeModelChoices, useModelPrefs } from "./frame/model-prefs";
import { useNavigation, useShownLineInAddress } from "./frame/navigation";
import type { NotesView } from "./frame/notes-side";
import { useKeyedDebounced, useToast, useViewportWidth } from "./frame/hooks";
import { BREAKPOINTS, focusLayoutFor, layoutFor } from "./frame/layout";
import type { DemoParams } from "./frame/params";
import { browserStorage, type DemoPrefs } from "./frame/prefs";
import { PrefsProviders } from "./frame/prefs-apply";
import { useF12ShellT } from "./frame/f12-shell-messages";
import { useThreadNotifications } from "./frame/thread-notify";
import { BackgroundReplyToast, useReplyToast } from "./frame/reply-toast";
import { SidePanelResizer, clampSideWidth, sideWidthMax, useSideWidth, ListResizer, clampListWidth, listWidthMax, useListWidth } from "./frame/side-resizer";

const PAGE_LOADED_AT = Date.now();
/** The docked send preview re-estimates once the draft has been still this long. */
const PREVIEW_DEBOUNCE_MS = 400;
/** The branch dialogs (and the form controls only they use) load on first use. */
const BranchFlows = lazy(() => import("./frame/branch-flows").then((module) => ({ default: module.BranchFlows })));
/**
 * Loaded on first use, so phones and the 420 embed start with only the
 * conversation: the conversation list (and its search), the structure and
 * notes tabs, the full-width map, the send preview and the settings dialog.
 */
const ConversationList = lazy(() => import("./frame/conversation-list").then((module) => ({ default: module.ConversationList })));
const ConversationRail = lazy(() => import("./frame/conversation-list").then((module) => ({ default: module.ConversationRail })));
const StructureSide = lazy(() => import("./frame/structure-host").then((module) => ({ default: module.StructureSide })));
const TurnPreview = lazy(() => import("./frame/preview-host").then((module) => ({ default: module.TurnPreview })));
const CommandPalette = lazy(() => import("./frame/palette-host").then((module) => ({ default: module.CommandPalette })));
const MapOverlay = lazy(() => import("./frame/map-overlay").then((module) => ({ default: module.MapOverlay })));
const NotesSide = lazy(() => import("./frame/notes-side").then((module) => ({ default: module.NotesSide })));
const InboxSide = lazy(() => import("./frame/inbox-side").then((module) => ({ default: module.InboxSide })));
const SettingsHost = lazy(() => import("./frame/settings-host").then((module) => ({ default: module.SettingsHost })));
/** P2 (F5): the goal capsule loads only while the goal feature is on; the review on first use. */
const GoalHost = lazy(() => import("./frame/goal-host").then((module) => ({ default: module.GoalHost })));
const ReviewHost = lazy(() => import("./frame/review-host").then((module) => ({ default: module.ReviewHost })));
const MemoryLibrary = lazy(() => import("./frame/memory-library").then((module) => ({ default: module.MemoryLibrary })));
/** F7: the header's conversation menu (shared with the list's rows) and the delete confirmation load on first use. */
const ConversationMenu = lazy(() => import("./frame/conversation-menu").then((module) => ({ default: module.ConversationMenu })));
const DeleteConversationDialog = lazy(() => import("./frame/delete-conversation").then((module) => ({ default: module.DeleteConversationDialog })));
/** F18: 刪除支線 and an aside's 丟掉 (the confirmation, the wait and its undo) load the first time one is asked for. */
const BranchDeleteHost = lazy(() => import("./frame/branch-delete-host").then((module) => ({ default: module.BranchDeleteHost })));
/** Focus mode (FOCUS_MODE.md): the map side, its node panel and the narrow 對話｜地圖 switch load when it is first turned on. */
const FocusPane = lazy(() => import("./frame/focus-pane").then((module) => ({ default: module.FocusPane })));
const FocusTabs = lazy(() => import("./frame/focus-pane").then((module) => ({ default: module.FocusTabs })));

/** The conversation list's columns while their code loads (and when it fails): same width, so the conversation does not move. */
const LIST_COLUMN = "h-full w-66 shrink-0 border-r border-tg-border bg-tg-surface-sunken";
const LIST_RAIL = "h-full w-14 shrink-0 border-r border-tg-border bg-tg-surface-sunken";
/** Where a dialog's or overlay's load failure shows: floating over the page, since the part itself never appeared. */
/** The header menu's place while its code loads: an icon button's size. */
const MENU_SLOT = "size-(--tg-control-height) min-w-(--tg-hit-target) min-h-(--tg-hit-target) shrink-0";
const FLOATING_FAILURE = "absolute top-16 left-1/2 z-50 -translate-x-1/2 rounded-tg border border-tg-border bg-tg-surface-raised shadow-tg-overlay";

interface CommandsProps {
  onToggleSide: () => void;
  onPreview: () => void;
  onToggleView: () => void;
  onToggleFocus: () => void;
}

/** Wires the shortcuts.md commands the frame owns; the conversation registers ⌘B, ⌘⇧S, ⌘[, Esc and ⌘Enter. */
function DemoCommands({ onToggleSide, onPreview, onToggleView, onToggleFocus }: CommandsProps) {
  useCommand("sidebar.toggle", onToggleSide);
  useCommand("turn.preview", onPreview);
  useCommand("structure.toggleView", onToggleView);
  useCommand("focus.toggle", onToggleFocus);
  return null;
}

/** Focus mode's remembered settings (§5); `?focus=1` opens it, and leaving takes the parameter off the address. */
function useFocusPrefs(fromUrl: boolean) {
  const [prefs, setPrefs] = useState<FocusPrefs>(() => {
    const stored = loadFocusPrefs(browserStorage());
    return fromUrl ? { ...stored, on: true } : stored;
  });
  const update = (next: FocusPrefs) => {
    setPrefs(next);
    saveFocusPrefs(browserStorage(), next);
    if (!next.on && new URLSearchParams(window.location.search).has("focus")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("focus");
      window.history.replaceState(window.history.state, "", url);
    }
  };
  return [prefs, update] as const;
}

/**
 * The demo app: one TangentRoot for the whole page, shortcuts heard on the
 * window (a full-page app; embedded hosts keep the default root target).
 */
export interface ShellProps {
  params: DemoParams;
  theme: TangentTheme;
  prefs: DemoPrefs;
  onPrefsChange: (prefs: DemoPrefs) => void;
}

export function Shell({ params, theme, prefs, onPrefsChange }: ShellProps) {
  const app = (
    <TangentRoot theme={theme} className="relative flex h-full overflow-hidden">
      {/* G2: the reader's keys, code and math options, clock, streaming and card defaults (prefs.ts). */}
      <PrefsProviders prefs={prefs}>
        <Frame params={params} prefs={prefs} onPrefsChange={onPrefsChange} />
      </PrefsProviders>
    </TangentRoot>
  );
  return params.frame === "embed" ? <EmbedFrame>{app}</EmbedFrame> : app;
}

/** F12 S1: the asides open in place under their messages, for the tree on screen (another tree starts with none). */
function useInlineAsides(rootId: string | null) {
  const [state, setState] = useState<{ root: string | null; ids: ReadonlySet<string>; focus: string | null }>({ root: rootId, ids: new Set(), focus: null });
  const ids = state.root === rootId ? state.ids : new Set<string>();
  const toggle = useCallback(
    (branch: BranchView, open?: boolean) =>
      setState((current) => {
        const base = current.root === rootId ? current.ids : new Set<string>();
        const next = new Set(base);
        const opening = open ?? !next.has(branch.lineId);
        if (opening) next.add(branch.lineId);
        else next.delete(branch.lineId);
        // Only an aside opened on purpose takes focus (its card's title).
        return { root: rootId, ids: next, focus: opening ? branch.lineId : null };
      }),
    [rootId],
  );
  return { ids, focus: state.root === rootId ? state.focus : null, toggle };
}

/** Per-line composer drafts: kept when switching lines and across reconnects. */
function useDrafts() {
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  return {
    get: (lineId: string) => drafts[lineId] ?? "",
    set: (lineId: string, value: string) => setDrafts((current) => ({ ...current, [lineId]: value })),
  };
}

function Frame({ params, prefs, onPrefsChange }: Omit<ShellProps, "theme">) {
  const t = useUiT();
  const width = useViewportWidth();
  const layout = layoutFor(width, params.frame);
  const [sideOverride, setSideOverride] = useState<{ mode: string; open: boolean } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [tab, setTab] = useState<SideTabId>("structure");
  // F10: 紀要｜備忘 inside the 紀要 tab, here so 記成備忘 can show the memo it wrote.
  const [notesView, setNotesView] = useState<NotesView>("notes");
  // F19: the term the side panel's 名詞表 shows open (asked from its underline in a reply, or 查看 after a save).
  const [focusTerm, setFocusTerm] = useState<{ termId: string; n: number } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // Mounted from the first opening on, so closing keeps Base UI's exit and focus return.
  const [previewUsed, setPreviewUsed] = useState(false);
  if (previewOpen && !previewUsed) setPreviewUsed(true);
  const [structureView, setStructureView] = useState<StructureView>("outline");
  const [mapFull, setMapFull] = useState(false);
  const [flow, setFlow] = useState<BranchFlow | null>(null);
  // F18: a delete outlives the flow that asked for it (it waits for its undo), so the frame's delete host takes it.
  const [branchDelete, setBranchDelete] = useState<BranchDeleteRequest | null>(null);
  const onFlow = useCallback((next: BranchFlow | null) => {
    if (next?.kind !== "deleteBranch") return setFlow(next);
    setBranchDelete((current) => ({ lineId: next.lineId, n: (current?.n ?? 0) + 1 }));
  }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const { current, focus, navigate, replace, clear } = useNavigation({ line: params.line, message: params.message });
  const [focusPrefs, setFocusPrefs] = useFocusPrefs(params.focus);
  const [focusTab, setFocusTab] = useState<FocusTab>("chat");
  // The side panel while focus mode is on: an overlay, closed until asked for (看全部紀要, ⌘.); leaving restores the old one.
  const [focusSideOpen, setFocusSideOpen] = useState(false);
  const focusOn = focusPrefs.on;
  const focusLayout = focusLayoutFor(width, params.frame);
  const readOnly = useReadOnly();
  const drafts = useDrafts();
  const toast = useToast();
  const startConversation = useNewConversation();

  const capabilities = useCapabilities();
  // The open-branch form offers the server's models (B5 `/capabilities.models`); without a list, only "same as the parent".
  // G2: without the models hidden in Settings → Providers, favourites first.
  const modelPrefs = useModelPrefs();
  const listedModels = modelChoices(capabilities.data);
  const modelOptions = listedModels ? arrangeModelChoices(listedModels, modelPrefs) : listedModels;
  const lines = useLines();
  const selected = current ?? lines.data?.lines[0]?.id ?? null;
  useShownLineInAddress(selected);
  const line = useLine(selected);
  // While the next line loads, keep the tree's root: the outline must not unmount (and lose focus) on every move.
  const lastRoot = useRef<string | null>(null);
  if (line.data) lastRoot.current = line.data.conversationBranch?.rootLineId ?? line.data.id;
  const rootId = lastRoot.current;
  // Asides included: the path must name the aside on screen too (the same query the outline reads).
  const branches = useBranches(rootId, true);
  // 待處理's count lives on the main line (B8 openSeeds + openSuggestions), whichever line is on screen.
  const rootLine = useLine(rootId);
  // F7: a deleted conversation on screen (here, elsewhere or found missing) gives way to the next one; nothing of it is read again.
  const deletion = useConversationDeletion({
    selected,
    rootId,
    lineError: line.error,
    // G2: with the delete confirmation off, 刪除對話… deletes at once.
    confirm: prefs.confirmDelete,
    toast: (message) => toast.show(message),
    leave: (gone) => {
      // B23: only some lines of the tree went: stay in it, on the nearest line above that is left.
      if (rootId && !gone.has(rootId)) {
        const outline = branches.data?.branches ?? [];
        let stay = selected;
        while (stay && gone.has(stay)) stay = outline.find((branch) => branch.lineId === stay)?.parentLineId ?? rootId;
        setFlow(null);
        return replace(stay ?? rootId);
      }
      const next = nextConversation(lines.data?.lines ?? [], gone, rootId);
      lastRoot.current = null;
      if (next) replace(next);
      else clear();
      setFlow(null);
      setReviewOpen(false);
      setMapFull(false);
    },
  });
  const inlineAsides = useInlineAsides(rootId);
  // F12 S4: a reply that finishes on another line of this tree, outside focus mode (decision #3).
  const replyToast = useReplyToast({
    rootId,
    selected,
    focusOn: focusPrefs.on,
    // G2: the in-app notice can be turned off (Settings → General).
    enabled: prefs.inAppNotifications,
    inline: inlineAsides.ids,
    describe: (lineId) => {
      const branch = branches.data?.branches.find((item) => item.lineId === lineId);
      return branch ? { title: branchTitle(branch, t), aside: branch.kind === "aside" } : { title: t("breadcrumb.main"), aside: false };
    },
  });
  // G2: a reply finished away from the screen (another line, or this tab in the background) may notify through the browser.
  const f12 = useF12ShellT();
  const threadNotify = useThreadNotifications({
    mode: prefs.threadNotifications,
    selected,
    describe: (lineId, failed) => {
      const branch = branches.data?.branches.find((item) => item.lineId === lineId);
      const conversation = lines.data?.lines.find((item) => item.id === lineId)?.title;
      const title = branch ? branchTitle(branch, t) : conversation || t("breadcrumb.main");
      return { title: t("shell.appName"), body: f12(failed ? "toast.replyFailed" : "toast.replyDone", { title }) };
    },
    onOpen: (lineId) => navigate(lineId),
  });
  useTangentEvents({
    onEvent: (event) => {
      deletion.onEvent(event);
      replyToast.onEvent(event);
      threadNotify(event);
    },
  });

  // An explicit toggle holds until the layout changes mode (e.g. a resize from column to overlay).
  const sideMode = focusOn && layout.side === "column" ? "overlay" : layout.side;
  const sideOpen = focusOn ? focusSideOpen : sideOverride?.mode === layout.side ? sideOverride.open : layout.sideOpenByDefault;
  const setSideOpen = (open: boolean) => (focusOn ? setFocusSideOpen(open) : setSideOverride({ mode: layout.side, open }));
  // Side by side, the conversation list steps aside too (§4.2).
  const list = focusOn && focusLayout === "split" ? "none" : layout.list === "rail" && railExpanded ? "column" : layout.list;
  // F12 S3: the column's width, within min(600, window − list − 480).
  const [storedSideWidth, setSideWidth] = useSideWidth();
  const [storedListWidth, setListWidth] = useListWidth();
  const listMax = listWidthMax(width);
  const activeListWidth = clampListWidth(storedListWidth, listMax);
  const listWidth = list === "column" ? activeListWidth : list === "rail" ? 56 : 0;
  const sideMax = sideWidthMax(width, listWidth);
  const sideWidth = clampSideWidth(storedSideWidth, sideMax);
  const toggleFocus = () => {
    setFocusPrefs({ ...focusPrefs, on: !focusOn });
    setFocusSideOpen(false);
    setFocusTab("chat");
    setMapFull(false);
  };
  // F9 B.3: phones have no map in the side sheet; 「樹狀地圖」 closes it and opens focus mode on its map tab.
  const openTreeMap = () => {
    setSideOverride({ mode: layout.side, open: false });
    setFocusPrefs({ ...focusPrefs, on: true });
    setFocusSideOpen(false);
    setFocusTab("map");
    setMapFull(false);
  };
  const path = rootId && selected ? pathItems(rootId, selected, branches.data?.branches ?? [], t("breadcrumb.main"), t) : [];
  const pathSize = params.frame === "embed" ? "embed" : width < BREAKPOINTS.portrait ? "phone" : "app";

  const select = (lineId: string, messageId?: string) => {
    navigate(lineId, messageId);
    setListOpen(false);
  };
  // Its own promise (R7 D1): every 新對話 press opens the conversation it made; a failure stays on the mutation's error.
  // G1: with this browser's default model and reasoning effort (model-prefs.ts), when the server still offers the model.
  const newConversation = () => void startConversation.create().then((created) => select(created.id), () => undefined);
  const openReview = () => {
    setReviewOpen(true);
    setListOpen(false);
    // The review covers the conversation; an overlay or sheet panel steps aside for it.
    if (layout.side !== "column") setSideOpen(false);
  };
  const f8 = useF8Frame({
    rootId,
    readOnly,
    onReview: openReview,
    onLibrary: () => setLibraryOpen(true),
    onNew: newConversation,
    onToggleTheme: () => onPrefsChange({ ...prefs, theme: prefs.theme === "dark" ? "light" : "dark" }),
    onOutline: () => {
      setTab("structure");
      setSideOpen(true);
    },
    setDraft: drafts.set,
  });
  // Stable while the side panel's mode stays (setSideOpen depends only on it), so card rows stay memoised.
  const showNotes = useCallback(() => {
    setTab("notes");
    setNotesView("notes");
    setSideOpen(true);
  }, [layout.side, focusOn]);
  const showTerm = useCallback((termId: string) => {
    setTab("notes");
    setNotesView("terms");
    setFocusTerm((current) => ({ termId, n: (current?.n ?? 0) + 1 }));
    setSideOpen(true);
  }, [layout.side, focusOn]);
  // 記成備忘 (B13; F10: in normal mode too): the selection toolbar, a message's menu and the composer write a memo on the line on screen.
  // Normal mode then shows it (紀要 → 備忘); focus mode keeps its side overlay closed, the map's node panel has the memos.
  const saveMemo = useMemoSaver({
    rootLineId: rootId,
    lineId: selected,
    enabled: !readOnly && isFeatureOn(capabilities.data, "memo"),
    toast: toast.show,
    onSaved: () => {
      setTab("notes");
      setNotesView("memos");
      if (!focusOn) setSideOpen(true);
    },
  });
  // F13: the import dialog, the decompose panel (it stands in for the side panel), the banner, the outlined messages.
  const f13 = useF13Frame({ selected, navigate, closeList: () => setListOpen(false), toast: toast.show, narrow: layout.narrow });
  const { decomposeShown, openDecompose } = f13;
  const listExtras = {
    onReview: openReview,
    reviewCount: inboxCount(capabilities.data, rootLine.data),
    onOpenLibrary: () => setLibraryOpen(true),
    onImport: f13.openImport,
    onDecompose: (target: { id: string }) => openDecompose(target.id),
    toast: (message: string) => toast.show(message),
  };
  const decomposeHost = (variant: "side" | "sheet") => (
    <DecomposeSlot frame={f13} lineId={selected} variant={variant} floatingClassName={FLOATING_FAILURE} navigate={navigate} onSpinoff={(lineId, atMessageId) => setFlow({ kind: "spinoff", lineId, atMessageId })} />
  );
  // ⌘⇧P and the token meter toggle the docked panel; the phone drawer only opens.
  const openPreview = () => selected && setPreviewOpen((open) => !open || !previewDocked);

  // The map needs room: none in the 420 embed or on phones (components.md).
  const allowMap = !layout.narrow;
  // On desktop the send preview is a non-modal panel in the conversation column (DESIGN §12); it follows the settled draft.
  // Focus mode always uses the drawer: no third column (§4.2).
  const previewDocked = params.frame === "app" && width >= BREAKPOINTS.tablet && !focusOn;
  // The open panel follows typing once it settles; opening it, or switching lines, always starts from that line's
  // current draft (a draft is never sent to another line's preview).
  const settledDraft = useKeyedDebounced(selected, selected ? drafts.get(selected) : "", previewOpen ? PREVIEW_DEBOUNCE_MS : 0);
  const focusComposer = () => document.querySelector<HTMLTextAreaElement>("main textarea")?.focus();
  const structure = { view: structureView, setView: setStructureView, mapFull, setMapFull };
  const panel = (
    <SideTabs
      capabilities={capabilities.data}
      value={tab}
      onValueChange={setTab}
      inboxCount={inboxCount(capabilities.data, rootLine.data)}
      panels={{
        structure:
          rootId && selected ? (
            <LazyRegion>
              <StructureSide rootLineId={rootId} lineId={selected} title={line.data?.title ?? ""} allowMap={allowMap} state={structure} navigate={navigate} onEscape={focusComposer} onExport={f8.openExport} onOpenTreeMap={layout.narrow && !focusOn ? openTreeMap : undefined} onFlow={onFlow} />
            </LazyRegion>
          ) : null,
        notes:
          rootId && selected ? (
            <LazyRegion>
              <NotesSide
                rootLineId={rootId}
                lineId={selected}
                navigate={navigate}
                // A modal dialog over everything: the panel stays, so closing the library brings focus back to 記憶庫 (R11).
                onOpenLibrary={() => setLibraryOpen(true)}
                view={notesView}
                onViewChange={setNotesView}
                onFlow={onFlow}
                toast={toast.show}
                focusTerm={focusTerm}
              />
            </LazyRegion>
          ) : null,
        inbox:
          rootId && selected ? (
            <LazyRegion>
              <InboxSide
                rootLineId={rootId}
                lineId={selected}
                navigate={navigate}
                onFlow={onFlow}
                onReview={openReview}
                onPrefill={f8.prefill}
                toast={toast.show}
              />
            </LazyRegion>
          ) : null,
      }}
    />
  );

  return (
    <>
      <DemoCommands
        onToggleSide={() => setSideOpen(!sideOpen)}
        onPreview={openPreview}
        onToggleView={() => allowMap && setStructureView(structureView === "map" ? "outline" : "map")}
        onToggleFocus={toggleFocus}
      />
      {list === "column" && (
        <LazyRegion fallback={<div aria-hidden style={{ width: activeListWidth }} className={LIST_COLUMN} />} className={LIST_COLUMN}>
          <ConversationList
            current={rootId ?? selected}
            onSelect={select}
            onNew={newConversation}
            onDelete={deletion.request}
            onCollapse={layout.list === "rail" ? () => setRailExpanded(false) : undefined}
            width={activeListWidth}
            resizer={<ListResizer width={activeListWidth} max={listMax} viewport={width} onChange={setListWidth} />}
            {...listExtras}
          />
        </LazyRegion>
      )}
      {list === "rail" && (
        <LazyRegion fallback={<div aria-hidden className={LIST_RAIL} />} className={LIST_RAIL}>
          <ConversationRail current={rootId ?? selected} onSelect={select} onNew={newConversation} onExpand={() => setRailExpanded(true)} />
        </LazyRegion>
      )}
      {list === "drawer" && listOpen && (
        <div className="absolute inset-0 z-30 flex">
          <LazyRegion fallback={<div aria-hidden style={{ width: activeListWidth, maxWidth: "85vw" }} className={LIST_COLUMN} />} className={LIST_COLUMN}>
            <ConversationList
              current={rootId ?? selected}
              onSelect={select}
              onNew={newConversation}
              onDelete={deletion.request}
              onCollapse={() => setListOpen(false)}
              width={activeListWidth}
              {...listExtras}
            />
          </LazyRegion>
          <button type="button" aria-label={t("shell.collapseList")} className="flex-1 bg-tg-scrim" onClick={() => setListOpen(false)} />
        </div>
      )}
      {/* Behind the open list drawer the conversation is covered by the scrim: out of reach for keyboard and assistive tech too. */}
      <main inert={list === "drawer" && listOpen} className="relative flex min-w-0 flex-1 flex-col">
        <Header
          path={path}
          pathSize={pathSize}
          usage={line.data?.usage ?? null}
          lineId={selected}
          busy={line.data?.status === "thinking"}
          showListButton={list === "drawer"}
          narrow={layout.narrow}
          sideOpen={sideOpen || decomposeShown}
          onNavigate={(lineId) => navigate(lineId)}
          onOpenList={() => setListOpen(true)}
          onToggleSide={() => {
            // While the decompose panel stands in for the side panel, the button brings the side panel back.
            if (decomposeShown) {
              f13.closeDecompose();
              setSideOpen(true);
            } else setSideOpen(!sideOpen);
          }}
          onPreview={openPreview}
          onSettings={() => setSettingsOpen(true)}
          {...(rootId ? { onSearch: f8.openSearch } : {})}
          focus={{ on: focusOn, onToggle: toggleFocus }}
          actions={
            // F7: only a whole conversation is archived or deleted, so only the main line has the menu; none for viewers.
            line.data && line.data.conversationBranch === null && !readOnly ? (
              <LazyRegion fallback={<span aria-hidden className={MENU_SLOT} />}>
                <ConversationMenu line={line.data} onDelete={deletion.request} onSearchInTree={f8.openSearch} onExport={f8.openExport} onDecompose={(target) => openDecompose(target.id)} />
              </LazyRegion>
            ) : undefined
          }
          goal={
            rootId && isFeatureOn(capabilities.data, "goal") ? (
              <LazyRegion>
                {/* Narrow frames keep the goal one press away as an icon (the full capsule needs the room, handoff width rules). */}
                <GoalHost rootLineId={rootId} compact={params.frame === "embed" || width < BREAKPOINTS.tablet} />
              </LazyRegion>
            ) : undefined
          }
        />
        {f8.searchOpen && rootId && (
          <LazyRegion fallback={<div aria-hidden className="h-8 shrink-0 border-b border-tg-border" />}>
            <SearchSlot key={rootId} rootLineId={rootId} rootTitle={rootLine.data?.title ?? ""} narrow={layout.narrow} navigate={navigate} onJumped={f8.onJumped} onFocusWithin={f8.onSearchFocus} onClose={f8.closeSearch} focusToken={f8.searchToken} />
          </LazyRegion>
        )}
        <ImportedSlot frame={f13} narrow={layout.narrow} />
        <RangeHighlight messageIds={f13.highlight} dim={flow?.kind === "extract"} />
        {focusOn && focusLayout === "tabs" && selected && (
          <LazyRegion>
            <FocusTabs tab={focusTab} onTab={setFocusTab} lineId={selected} />
          </LazyRegion>
        )}
        <div className="relative flex min-h-0 flex-1">
          {selected ? (
            <ConversationView
              key={selected}
              lineId={selected}
              onPrefill={f8.prefill}
              draft={drafts.get(selected)}
              onDraftChange={(value) => drafts.set(selected, value)}
              forcedBanner={bannerFor(params.state, PAGE_LOADED_AT)}
              focus={focus}
              onFlow={onFlow}
              navigate={navigate}
              onPreview={openPreview}
              toast={toast.show}
              notice={f8.noticeFor(selected)}
              onShowNotes={showNotes}
              onDismissNotice={f8.dismissNotice}
              expandMessageId={f8.expandMessageId}
              inlineAsides={inlineAsides.ids}
              focusAsideId={inlineAsides.focus}
              onToggleAside={inlineAsides.toggle}
              onShowTerm={showTerm}
              {...(saveMemo ? { onMemo: saveMemo } : {})}
            />
          ) : (
            <section aria-label={t("shell.conversation")} className="flex flex-1 items-center justify-center p-8 text-tg-sm text-tg-muted">
              {lines.isSuccess ? t("shell.selectConversation") : t("ui.loading")}
            </section>
          )}
          {focusOn && rootId && selected && (
            <LazyRegion key={`focus:${rootId}`} className={FLOATING_FAILURE}>
              <FocusPane
                layout={focusLayout}
                tab={focusTab}
                onTab={setFocusTab}
                rootLineId={rootId}
                lineId={selected}
                windowWidth={width}
                prefs={focusPrefs}
                onPrefs={setFocusPrefs}
                navigate={navigate}
                onFlow={onFlow}
                draft={{ get: () => drafts.get(selected), set: (value) => drafts.set(selected, value) }}
                focusComposer={focusComposer}
                toast={toast.show}
                onShowAllNotes={() => {
                  setTab("notes");
                  setNotesView("notes");
                  setFocusSideOpen(true);
                }}
              />
            </LazyRegion>
          )}
          {selected && previewDocked && previewUsed && (
            <LazyRegion className={FLOATING_FAILURE}>
              <TurnPreview key={`preview-${selected}`} mode="panel" open={previewOpen} onOpenChange={setPreviewOpen} lineId={selected} content={settledDraft} lineUsage={line.data?.usage ?? null} />
            </LazyRegion>
          )}
          {reviewOpen && rootId && selected && (
            <LazyRegion className={FLOATING_FAILURE}>
              <ReviewHost rootLineId={rootId} lineId={selected} navigate={navigate} onFlow={onFlow} onClose={() => setReviewOpen(false)} />
            </LazyRegion>
          )}
          {libraryOpen && (
            <LazyRegion className={FLOATING_FAILURE}>
              <MemoryLibrary navigate={navigate} onClose={() => setLibraryOpen(false)} />
            </LazyRegion>
          )}
          {mapFull && allowMap && !focusOn && rootId && selected && (
            <LazyRegion className={FLOATING_FAILURE}>
              <MapOverlay rootLineId={rootId} lineId={selected} navigate={navigate} onClose={() => setMapFull(false)} onSideBySide={toggleFocus} />
            </LazyRegion>
          )}
          {sideMode !== "column" && (
            <SidePanel mode={sideMode} open={sideOpen && !decomposeShown} onOpenChange={setSideOpen} label={t("sideTabs.label")} className={layout.narrow ? "w-full" : undefined}>
              {panel}
            </SidePanel>
          )}
        </div>
        {sideMode !== "column" && decomposeHost("sheet")}
      </main>
      {sideMode === "column" && decomposeHost("side")}
      {sideMode === "column" && !decomposeShown && (
        <SidePanel
          mode="column"
          open={sideOpen}
          onOpenChange={setSideOpen}
          label={t("sideTabs.label")}
          width={sideWidth}
          resizer={<SidePanelResizer width={sideWidth} max={sideMax} viewport={width} onChange={setSideWidth} />}
        >
          {panel}
        </SidePanel>
      )}
      {selected && !previewDocked && previewUsed && (
        <LazyRegion className={FLOATING_FAILURE}>
          <TurnPreview open={previewOpen} onOpenChange={setPreviewOpen} lineId={selected} content={drafts.get(selected)} lineUsage={line.data?.usage ?? null} />
        </LazyRegion>
      )}
      {flow && (
        <LazyRegion className={FLOATING_FAILURE}>
          <BranchFlows
            flow={flow}
            onChange={onFlow}
            navigate={navigate}
            toast={toast.show}
            onPrefill={f8.prefill}
            onShowParking={() => {
              setTab("inbox");
              setSideOpen(true);
            }}
            onHighlight={f13.setHighlight}
            onShowGlossary={showTerm}
            {...(modelOptions ? { modelOptions } : {})}
          />
        </LazyRegion>
      )}
      {branchDelete && (
        <LazyRegion className={FLOATING_FAILURE}>
          <BranchDeleteHost request={branchDelete} rootId={rootId} outline={branches.data?.branches ?? []} onGone={deletion.linesGone} navigate={navigate} toast={toast.show} />
        </LazyRegion>
      )}
      <ImportSlot frame={f13} floatingClassName={FLOATING_FAILURE} />
      {deletion.dialog && (
        <LazyRegion className={FLOATING_FAILURE}>
          <DeleteConversationDialog {...deletion.dialog} />
        </LazyRegion>
      )}
      {settingsOpen && (
        <LazyRegion className={FLOATING_FAILURE}>
          <SettingsHost open onOpenChange={setSettingsOpen} params={params} lineId={selected} onSelect={select} />
        </LazyRegion>
      )}
      {f8.dialog && rootId && selected && (
        <LazyRegion className={FLOATING_FAILURE}>
          <DialogSlot which={f8.dialog} onClose={f8.closeDialog} rootLineId={rootId} lineId={selected} title={rootLine.data?.title ?? ""} outline={branches.data?.branches ?? []} />
        </LazyRegion>
      )}
      <LazyRegion className={FLOATING_FAILURE}>
        <CommandPalette />
      </LazyRegion>
      {/* One stack for both toasts (F12 S4): the background-reply notice sits above the frame's toast, never on it; z-40 stays behind modal dialogs (z-50). */}
      <div className="pointer-events-none absolute inset-x-3 bottom-24 z-40 flex flex-col items-center gap-2">
        <div role="status" aria-live="polite" data-tg-reply-toast-region="" className="flex w-full justify-center">
          {replyToast.toast && <BackgroundReplyToast toast={replyToast.toast} onView={(lineId) => navigate(lineId)} onClose={replyToast.dismiss} />}
        </div>
      <div role="status" aria-live="polite" className="pointer-events-none flex max-w-full justify-center">
        {toast.message && (
          <span className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-tg bg-tg-foreground-strong px-3.5 py-2 text-tg-sm text-tg-background shadow-tg-overlay">
            {toast.message}
            {toast.action && (
              <button type="button" onClick={toast.action.run} className="pointer-events-auto inline-flex min-h-6 shrink-0 items-center px-1 font-medium whitespace-nowrap underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current pointer-coarse:min-h-10">
                {toast.action.label}
              </button>
            )}
          </span>
        )}
      </div>
      </div>
    </>
  );
}
