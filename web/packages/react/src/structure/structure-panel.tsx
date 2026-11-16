import { branchTitle, isFeatureOn, isHostNotice, type BranchView, type Chapter } from "@tangent/client";
import { Download, GitFork, ListTree, Network } from "lucide-react";
import { Button } from "../components/button";
import { lazy, type KeyboardEvent, type ReactNode } from "react";
import { useBranches, useCapabilities, useMainChapters, useMessages, useReadOnly, useRenameBranch } from "../data";
import { Skeleton } from "../components/display";
import { LazyRegion } from "../components/lazy-region";
import { GroupList } from "../groups/group-list";
import { useMapGroups, useSelectionActions, type SelectionHandler } from "../groups/map-groups-data";
import { useMapTags } from "../p3/map-tags-data";
import { useGroupForm } from "../groups/use-group-form";
import { useTreeMapT } from "../i18n/tree-map-messages";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useMapFisheye } from "../p2/map-fisheye-data";
import { useMapRelationsData } from "../p2/map-relations-data";
import { RelationsSection } from "../p2/relations-section";
import { ChapterList } from "./chapter-list";
import { ExportBar } from "./export-bar";
import { useStaleBranches } from "../f8/stale-badge";
import { OutlineTree } from "./outline-tree";

export type StructureView = "outline" | "map" | "chapters";

/** The map (and its layout code) loads the first time it is shown: phones and the 420 embed never need it. */
const BranchMap = lazy(() => import("./branch-map").then((module) => ({ default: module.BranchMap })));

export interface StructurePanelProps {
  rootLineId: string;
  /** The line on screen. */
  currentLineId: string;
  /** The conversation's title (exports). */
  title: string;
  view: StructureView;
  onViewChange: (view: StructureView) => void;
  /** 420 embedded and phones show no map (components.md). */
  allowMap: boolean;
  /** Switch to a line (the root id for the main line). */
  onEnter: (lineId: string) => void;
  /** Scroll to and highlight a message of the line on screen (chapters). */
  onJump: (messageId: string) => void;
  /** Esc in the outline: focus back to the composer. */
  onEscape?: () => void;
  /** The host can open the map over the conversation. */
  onToggleMapFullscreen?: () => void;
  /** The map is open over the conversation; the panel then only says so. */
  mapFullscreen?: boolean;
  /** Goes to a line of any conversation, at a message when given (a relation's end, C3); defaults to `onEnter`. */
  onOpen?: (lineId: string, messageId?: string) => void;
  /** F8 S9: one 「匯出…」 opens the host's export dialog instead of the three outline formats. */
  onExport?: () => void;
  /** F9 B.3: narrow screens' 「樹狀地圖」 (the host opens focus mode's map); shown only when given. */
  onOpenTreeMap?: () => void;
  /** F18 刪除支線 on an outline row (an ended aside, a discarded branch); the host asks first or offers an undo. */
  onDeleteBranch?: (branch: BranchView) => void;
  className?: string;
}

function ViewSwitch({ views, value, onChange }: { views: readonly StructureView[]; value: StructureView; onChange: (view: StructureView) => void }) {
  const t = useUiT();
  const icons: Record<StructureView, ReactNode> = { outline: <ListTree aria-hidden />, map: <Network aria-hidden />, chapters: <GitFork aria-hidden /> };
  const labels = { outline: t("structure.outline"), map: t("structure.map"), chapters: t("structure.chapters") };
  // Radio semantics: one tab stop, arrows move and select.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const group = event.currentTarget;
    const next = views[(views.indexOf(value) + step + views.length) % views.length] ?? value;
    onChange(next);
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={t("structure.views")} onKeyDown={onKeyDown} className="flex gap-0.5 self-start rounded-tg-sm bg-tg-surface-sunken p-0.5">
      {views.map((view) => (
        <button
          key={view}
          type="button"
          role="radio"
          data-view={view}
          aria-checked={view === value}
          tabIndex={view === value ? 0 : -1}
          onClick={() => onChange(view)}
          className={cx(
            "flex h-6.5 items-center gap-1.25 rounded-tg-sm px-2.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11 [&_svg]:size-3.25",
            view === value ? "bg-tg-surface-raised text-tg-foreground shadow-tg" : "text-tg-muted hover:text-tg-foreground",
          )}
        >
          {icons[view]}
          {labels[view]}
        </button>
      ))}
    </div>
  );
}

/** F9 B.3: the way from the narrow screens' outline to focus mode's tree map (44px on touch). */
function TreeMapButton({ onOpen }: { onOpen: () => void }) {
  const t = useTreeMapT();
  return (
    <Button variant="ghost" size="sm" title={t("structure.openTreeMapHint")} icon={<Network aria-hidden className="size-3.5" />} className="ml-auto pointer-coarse:min-h-11" onClick={onOpen}>
      {t("structure.openTreeMap")}
    </Button>
  );
}

/**
 * The side panel's 結構 (A8, A10): a switch between the outline (with
 * export), the map (not on narrow frames) and chapters (chapters feature).
 */
export function StructurePanel(props: StructurePanelProps) {
  const { rootLineId, currentLineId, title, view, onViewChange, allowMap, onEnter, onJump, className } = props;
  const t = useUiT();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const branches = useBranches(rootLineId, true);
  const rename = useRenameBranch(rootLineId);
  const main = useMessages(rootLineId);
  const current = useMessages(currentLineId);
  const chaptersOn = isFeatureOn(capabilities.data, "chapters");
  const leavesOn = isFeatureOn(capabilities.data, "leaf");
  const views: StructureView[] = ["outline", ...(allowMap ? (["map"] as const) : []), ...(chaptersOn ? (["chapters"] as const) : [])];
  const shown = views.includes(view) ? view : "outline";
  const list = branches.data?.branches ?? [];
  const mainCount = (main.data?.messages ?? []).filter((message) => message.kind === "chat" && message.role !== "system").length;
  const currentMessages = current.data?.messages ?? [];
  // A host's notice (B7.2) is never an anchor.
  const anchor = currentMessages.filter((message) => message.kind === "chat" && message.status === "done" && !isHostNotice(message)).at(-1)?.id ?? null;
  const relationsOn = isFeatureOn(capabilities.data, "relations");
  const mapRelations = useMapRelationsData(rootLineId);
  const mapFisheye = useMapFisheye(rootLineId, currentLineId);
  const currentBranch = list.find((branch) => branch.lineId === currentLineId);
  const start = { lineId: currentLineId, label: currentBranch ? branchTitle(currentBranch, t) : t("breadcrumb.main") };
  const open = props.onOpen ?? ((lineId: string) => onEnter(lineId));
  // C2: a selection in the outline or the map becomes a group or a combined branch (which it then enters).
  // Local state (selection, folds, forms) belongs to one conversation: keyed by its root (R9 G1).
  const form = useGroupForm(rootLineId, (result) => result.lineId && onEnter(result.lineId));
  const act: SelectionHandler = (mode, members) => form.open({ mode, members });
  const selection = useSelectionActions(rootLineId, act);
  const mapGroups = useMapGroups(rootLineId, act);
  const mapTags = useMapTags();
  const staleIds = useStaleBranches(rootLineId, list);
  // F11 §3: the main line's stages in the outline and the map (the chapters feature); a stage goes to its first message.
  const mainChapters = useMainChapters(rootLineId);
  const goToChapter = (chapter: Chapter) => {
    if (props.onOpen) props.onOpen(rootLineId, chapter.startMessageId);
    else onJump(chapter.startMessageId);
  };
  // A stage goes to its start message: from a branch that needs the host's onOpen (onEnter would lose the message).
  const stages = mainChapters && (props.onOpen || currentLineId === rootLineId) ? { chapters: mainChapters, onGoToChapter: goToChapter } : {};
  return (
    <div className={cx("flex min-h-0 flex-1 flex-col gap-2 pt-2.5", className)}>
      <div className="flex flex-wrap items-center gap-2 px-3">
        <ViewSwitch views={views} value={shown} onChange={onViewChange} />
        {props.onOpenTreeMap && <TreeMapButton onOpen={props.onOpenTreeMap} />}
      </div>
      {shown === "outline" && (
        <>
          <OutlineTree
            key={`outline:${rootLineId}`}
            branches={list}
            rootLineId={rootLineId}
            currentLineId={currentLineId}
            mainCount={mainCount}
            readOnly={readOnly}
            showLeaves={leavesOn}
            showTags={mapTags !== undefined}
            staleIds={staleIds}
            onEnter={onEnter}
            onRename={(lineId, purpose) => rename.mutateAsync({ lineId, purpose })}
            {...(props.onEscape ? { onEscape: props.onEscape } : {})}
            {...(props.onDeleteBranch ? { onDelete: props.onDeleteBranch } : {})}
            {...(selection ? { selectionActions: selection.render, onSelectionKey: selection.onKey } : {})}
            {...stages}
            className="min-h-0 flex-1"
          />
          {/* F19 §4: neither shows while it has nothing to list (a 「群組 0」 and a 「關聯 0」 used to sit under every outline). */}
          <GroupList key={`groups:${rootLineId}`} rootLineId={rootLineId} onGo={onEnter} hideWhenEmpty className="max-h-60 shrink-0 overflow-auto px-3" />
          {relationsOn && <RelationsSection key={`relations:${rootLineId}`} rootLineId={rootLineId} start={start} onGo={open} hideWhenEmpty className="max-h-60 shrink-0 overflow-auto px-3" />}
          {props.onExport ? (
            <div className="flex items-center border-t border-tg-border px-3 py-2">
              <Button variant="ghost" size="sm" icon={<Download aria-hidden className="size-3.5" />} onClick={props.onExport}>
                {t("command.export.open")}
              </Button>
            </div>
          ) : (
            <ExportBar title={title} branches={list} />
          )}
        </>
      )}
      {shown === "map" &&
        (props.mapFullscreen ? (
          <p className="m-0 px-4 text-tg-xs text-tg-muted">{t("map.fullNote")}</p>
        ) : (
          <LazyRegion fallback={<Skeleton className="mx-2 mb-2 h-60" />} className="mx-2 mb-2">
            <BranchMap
              key={rootLineId}
              branches={list}
              rootLineId={rootLineId}
              currentLineId={currentLineId}
              mainCount={mainCount}
              showLeaves={leavesOn}
              onEnter={onEnter}
              {...(mapRelations ? { relations: mapRelations } : {})}
              {...(mapFisheye ? { fisheye: mapFisheye } : {})}
              {...(mapGroups ? { groups: mapGroups } : {})}
              {...(mapTags ? { tags: mapTags } : {})}
              {...stages}
              {...(props.onToggleMapFullscreen ? { onToggleFullscreen: props.onToggleMapFullscreen } : {})}
              className="mx-2 mb-2"
            />
          </LazyRegion>
        ))}
      {form.dialog}
      {shown === "chapters" && <ChapterList key={currentLineId} rootLineId={rootLineId} lineId={currentLineId} messages={currentMessages} anchorMessageId={anchor} onJump={onJump} readOnly={readOnly} />}
    </div>
  );
}
