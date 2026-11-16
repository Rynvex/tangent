import { StructurePanel, useLine, type StructureView } from "@tangent/react";
import { useLayoutEffect, useRef } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";

export interface StructureState {
  view: StructureView;
  setView: (view: StructureView) => void;
  mapFull: boolean;
  setMapFull: (full: boolean) => void;
}

export interface StructureSideProps {
  rootLineId: string;
  lineId: string;
  title: string;
  allowMap: boolean;
  state: StructureState;
  navigate: Navigate;
  /** Esc in the outline: back to the composer. */
  onEscape: () => void;
  /** F8 S9: 「匯出…」 under the outline. */
  onExport?: () => void;
  /** F9 B.3: phones' 「樹狀地圖」 (focus mode's map tab). */
  onOpenTreeMap?: (() => void) | undefined;
  /** F18: the outline's 刪除支線 (the frame's delete host asks first or offers an undo). */
  onFlow?: (flow: BranchFlow) => void;
}

/** The side panel's 結構 wired to the demo's navigation (A8, A10). */
/** The side map's full-width toggle (BranchMap marks it). */
const FULL_TOGGLE = "[data-tg-map-full]";

/**
 * Leaving the full-width map unmounts what had focus (the overlay); the side
 * map's full-width toggle, which opened it, takes focus back.
 */
function useReturnFromFullMap(mapFull: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const was = useRef(mapFull);
  useLayoutEffect(() => {
    const closed = was.current && !mapFull;
    was.current = mapFull;
    const focus = document.activeElement;
    const lost = !focus || focus === document.body || !focus.isConnected;
    if (closed && lost) box.current?.querySelector<HTMLElement>(FULL_TOGGLE)?.focus();
  }, [mapFull]);
  return box;
}

export function StructureSide({ rootLineId, lineId, title, allowMap, state, navigate, onEscape, onExport, onOpenTreeMap, onFlow }: StructureSideProps) {
  const box = useReturnFromFullMap(state.mapFull);
  // An archived conversation refuses every delete: the outline does not offer one (it used to, and brought the branch back five seconds later).
  const archived = Boolean(useLine(rootLineId).data?.archivedAt);
  return (
    <div ref={box} className="contents">
      <StructurePanel
        rootLineId={rootLineId}
        currentLineId={lineId}
        title={title}
        view={state.view}
        onViewChange={state.setView}
        allowMap={allowMap}
        onEnter={(target) => navigate(target)}
        onJump={(messageId) => navigate(lineId, messageId)}
        onOpen={(target, messageId) => navigate(target, messageId)}
        onEscape={onEscape}
        onToggleMapFullscreen={() => state.setMapFull(!state.mapFull)}
        mapFullscreen={state.mapFull}
        {...(onExport ? { onExport } : {})}
        {...(onOpenTreeMap ? { onOpenTreeMap } : {})}
        {...(onFlow && !archived ? { onDeleteBranch: (branch) => onFlow({ kind: "deleteBranch", lineId: branch.lineId }) } : {})}
      />
    </div>
  );
}
