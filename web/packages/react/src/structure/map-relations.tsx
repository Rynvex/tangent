/**
 * Wires the relation layer into the branch map (C3): which relations and AI
 * proposals can be drawn, the 關聯 layer switch, and pointer / keyboard
 * events for making a relation (interactions.md): drag from a node's dot, or
 * R on a node → arrow keys → Enter → the note.
 */
import { MAP_ROOT_KEY, branchTitle, relationSuggestionOf, relationsOnMap, type Link, type MapLayout } from "@tangent/client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useUiT } from "../provider";
import type { Point } from "./relation-geometry";
import { useRelationDeletion, type DrawnSuggestion, type MapRelationsProps } from "./relation-layer";
import { useRelationLink } from "./use-relation-link";

/** Dragging this close to the canvas edge pans it (interactions: 8px a step). */
const EDGE_PX = 24;
const PAN_STEP_PX = 8;

export interface MapRelationLayerOptions {
  relations: MapRelationsProps | undefined;
  layout: MapLayout;
  rootLineId: string;
  canvas: RefObject<HTMLDivElement | null>;
  zoom: number;
  mainName: string;
}

const focusNode = (canvas: HTMLElement | null, key: string) => canvas?.querySelector<HTMLElement>(`[data-tg-map-node="${CSS.escape(key)}"] > button`)?.focus();

export function useMapRelationLayer({ relations, layout, rootLineId, canvas, zoom, mainName }: MapRelationLayerOptions) {
  const t = useUiT();
  const [shown, setShown] = useState(true);
  const active = Boolean(relations) && shown;
  const keyOf = useCallback((lineId: string) => (lineId === rootLineId ? MAP_ROOT_KEY : lineId), [rootLineId]);
  const lineOf = (key: string) => (key === MAP_ROOT_KEY ? rootLineId : key);
  const nodeKeys = useMemo(() => new Set(layout.nodes.map((node) => node.key)), [layout]);
  const drawn = useMemo(() => (active && relations ? relationsOnMap(relations.relations, rootLineId, nodeKeys).drawn : []), [active, relations, rootLineId, nodeKeys]);
  const suggested = useMemo<DrawnSuggestion[]>(() => {
    if (!active || !relations) return [];
    return relations.suggestions.flatMap((suggestion) => {
      const proposal = suggestion.status === "open" ? relationSuggestionOf(suggestion) : null;
      if (!proposal) return [];
      const from = keyOf(proposal.fromLineId);
      const to = keyOf(proposal.toLineId);
      return nodeKeys.has(from) && nodeKeys.has(to) ? [{ suggestion, from, to, label: proposal.label }] : [];
    });
  }, [active, relations, keyOf, nodeKeys]);
  const relatedTo = useCallback(
    (key: string) => new Set(drawn.flatMap((item) => (item.from === key ? [item.to] : item.to === key ? [item.from] : []))),
    [drawn],
  );
  const link = useRelationLink({ nodes: layout.nodes, relatedTo });
  const deletion = useRelationDeletion(relations);
  const canLink = active && relations !== undefined && !relations.readOnly;
  const name = (key: string) => {
    const branch = layout.byKey.get(key)?.branch;
    return branch ? branchTitle(branch, t) : mainName;
  };

  const toLayout = (event: { clientX: number; clientY: number }): Point => {
    const box = canvas.current;
    const rect = box?.getBoundingClientRect();
    return { x: (event.clientX - (rect?.left ?? 0) + (box?.scrollLeft ?? 0)) / zoom, y: (event.clientY - (rect?.top ?? 0) + (box?.scrollTop ?? 0)) / zoom };
  };
  /** Near an edge while dragging: the canvas pans a step (no animation, so reduced motion needs nothing more). */
  const autoPan = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current;
    const rect = box?.getBoundingClientRect();
    if (!box || !rect || rect.width === 0) return;
    if (event.clientX > rect.right - EDGE_PX) box.scrollLeft += PAN_STEP_PX;
    else if (event.clientX < rect.left + EDGE_PX) box.scrollLeft -= PAN_STEP_PX;
    if (event.clientY > rect.bottom - EDGE_PX) box.scrollTop += PAN_STEP_PX;
    else if (event.clientY < rect.top + EDGE_PX) box.scrollTop -= PAN_STEP_PX;
  };

  const mode = link.mode;
  // The relation is made the moment the other end is chosen (interactions.md); the note follows with PATCH.
  const making = useRef<{ key: string; created: Promise<Link | null> } | null>(null);
  useEffect(() => {
    if (mode.kind !== "labeling" || !relations) return;
    const key = `${mode.from}->${mode.to}`;
    if (making.current?.key === key) return;
    const created = relations.onCreate(lineOf(mode.from), lineOf(mode.to)).catch((failure: unknown) => {
      deletion.run(() => Promise.reject(failure));
      return null;
    });
    making.current = { key, created };
    // lineOf and deletion are stable enough per render; only a new pair starts a creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, relations]);
  const roleOf = (key: string): "source" | "candidate" | "target" | null => {
    if (mode.kind === "idle") return null;
    if (key === mode.from) return "source";
    const target = mode.kind === "dragging" ? mode.over : mode.kind === "targeting" ? mode.target : mode.to;
    if (key === target) return "target";
    return mode.kind !== "labeling" && !relatedTo(mode.from).has(key) ? "candidate" : null;
  };

  return {
    shown: active,
    setShown,
    drawn,
    suggested,
    mode,
    deletion,
    canLink,
    name,
    fromName: mode.kind === "idle" ? "" : name(mode.from),
    roleOf,
    choosing: mode.kind === "targeting",
    choose: link.choose,
    startDrag: (key: string, event: PointerEvent<HTMLSpanElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      canvas.current?.setPointerCapture?.(event.pointerId);
      link.startDrag(key, toLayout(event));
    },
    /** True when the move belonged to a drag (the map does not pan then). */
    onPointerMove: (event: PointerEvent<HTMLDivElement>): boolean => {
      if (mode.kind !== "dragging") return false;
      autoPan(event);
      link.moveDrag(toLayout(event));
      return true;
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      if (mode.kind === "dragging") link.endDrag(toLayout(event));
    },
    /** Another finger came down (a pinch) or the system took the pointer: the drag ends without a relation. */
    cancelDrag: () => {
      if (mode.kind === "dragging") link.cancel();
    },
    /** R on a node starts choosing; arrows move among the candidates; Esc cancels. True when handled. */
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>): boolean => {
      const target = event.target instanceof Element ? event.target : null;
      if (mode.kind === "targeting") {
        if (event.key === "Escape") {
          link.cancel();
          focusNode(canvas.current, mode.from);
        } else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
          const next = link.stepTarget(mode, event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1);
          if (next) focusNode(canvas.current, next);
        } else return false;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      const node = target?.closest("[data-tg-map-node]")?.getAttribute("data-tg-map-node");
      if (!canLink || mode.kind !== "idle" || !node || target?.closest("input") || event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "r") return false;
      event.preventDefault();
      link.startTargeting(node);
      return true;
    },
    /** The note is written (or left blank, keeping the relation without one); focus goes back to where it started. */
    commit: (label: string) => {
      if (mode.kind !== "labeling" || !relations) return;
      const { from } = mode;
      const pending = making.current?.created;
      making.current = null;
      link.cancel();
      if (label && pending) {
        void pending.then((relation) => {
          if (relation) deletion.run(() => relations.onUpdateLabel(relation, label));
        });
      }
      requestAnimationFrame(() => focusNode(canvas.current, from));
    },
    /** 改說明 on a selected relation. */
    editLabel: (relation: Link, label: string) => relations && deletion.run(() => relations.onUpdateLabel(relation, label)),
  };
}
