/**
 * F17: the mind map workspace's own state over step 2's assembly: the model
 * and its layout, the selected node (followed to its new key when a move
 * renames it), the turn order overlay, the zoom, and a round dragged from
 * the inspector onto a node (S5b). Nodes themselves are dragged with F16.1's
 * AssemblyDnd, so a drop does exactly what the list's drop zones do.
 */
import { buildImportMindMapLayout, MINDMAP_ROOT_KEY, NEW_STANDALONE } from "@tangent/client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AiTreeView } from "./use-ai-tree";
import { useF14T } from "./f14-messages";
import { buildMindMapModel, type MindMapModel } from "./mindmap-model";
import type { Assembly } from "./use-assembly";

/** The zoom steps of 縮小／放大 and the range 置中適應 stays in. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

/** A round dragged from the inspector (its unit and number). */
export interface TurnDrag {
  unit: string;
  turn: number;
}

export interface UseMindMapInput {
  assembly: Assembly;
  view: AiTreeView | null;
  touch: boolean;
}

/** What was selected: a node's key and the units it held then (to follow it when a move gives it another key). */
interface Chosen {
  key: string | null;
  units: readonly string[];
}

/** The node to show: the same key, else the node holding most of its units, else (desktop) the first node. */
function follow(model: MindMapModel, chosen: Chosen, fallback: boolean): string | null {
  const { key, units } = chosen;
  if (key === MINDMAP_ROOT_KEY || (key && model.byKey.has(key))) return key;
  const overlap = (unitsOf: readonly string[]) => unitsOf.filter((unit) => units.includes(unit)).length;
  const best = model.nodes.reduce<{ key: string | null; n: number }>((top, node) => (overlap(node.units) > top.n ? { key: node.key, n: overlap(node.units) } : top), { key: null, n: 0 });
  if (best.key) return best.key;
  return fallback && key !== null ? (model.nodes[0]?.key ?? null) : null;
}

export function useMindMap({ assembly, view, touch }: UseMindMapInput) {
  const t = useF14T();
  const forkMoved = view?.forkMoved;
  const model = useMemo(
    () =>
      buildMindMapModel({
        blueprint: assembly.blueprint,
        sessions: assembly.byKey,
        orderedOriginal: assembly.orderedOriginal,
        merges: assembly.state.merges,
        analysis: view?.analysis ?? null,
        forkMoved: forkMoved ?? new Set(),
        untitled: t("import.untitled"),
      }),
    [assembly.blueprint, assembly.byKey, assembly.orderedOriginal, assembly.state.merges, view?.analysis, forkMoved, t],
  );
  const layout = useMemo(() => buildImportMindMapLayout(model.input), [model.input]);
  const [chosen, setChosen] = useState<Chosen>(() => ({ key: touch ? null : (model.nodes[0]?.key ?? null), units: touch ? [] : (model.nodes[0]?.units ?? []) }));
  const selected = follow(model, chosen, !touch);
  const node = selected ? (model.byKey.get(selected) ?? null) : null;
  const [trace, setTrace] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [turnDrag, setTurnDrag] = useState<TurnDrag | null>(null);
  const dragged = useRef<TurnDrag | null>(null);
  const shown = useRef(0);
  useEffect(() => () => window.clearTimeout(shown.current), []);

  const endTurnDrag = () => {
    dragged.current = null;
    window.clearTimeout(shown.current);
    setTurnDrag(null);
  };

  return {
    model,
    layout,
    selected,
    node,
    select: (key: string | null) => setChosen({ key, units: (key && model.byKey.get(key)?.units) || [] }),
    trace: trace && layout.trace.range !== null,
    canTrace: layout.trace.range !== null,
    toggleTrace: () => setTrace((on) => !on),
    zoom,
    setZoom: (next: number) => setZoomState(clampZoom(next)),
    zoomIn: () => setZoomState((current) => clampZoom(current * ZOOM_STEP)),
    zoomOut: () => setZoomState((current) => clampZoom(current / ZOOM_STEP)),
    turnDrag,
    /** Whether a round is being dragged now (read at once, before the next render). */
    isDraggingTurn: () => dragged.current !== null,
    startTurnDrag: (drag: TurnDrag) => {
      dragged.current = drag;
      // Chrome ends a drag whose source moves while dragstart runs: the drop targets appear just after it.
      window.clearTimeout(shown.current);
      shown.current = window.setTimeout(() => setTurnDrag(drag), 0);
    },
    endTurnDrag,
    /** The dragged round dropped on a node (or the lane: a separate conversation of its own). */
    dropTurn: (target: string) => {
      const drag = dragged.current;
      endTurnDrag();
      if (drag && view) view.moveUnit(drag.unit, target === "lane" ? NEW_STANDALONE : target);
    },
  };
}

export type MindMap = ReturnType<typeof useMindMap>;
