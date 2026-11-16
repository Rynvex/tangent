/**
 * The relation-linking states of interactions.md 「地圖拉關聯線」: idle →
 * dragging (from a node's dot) or targeting (R on a node) → labeling → back
 * to idle once the relation is made (with or without its note). Pure
 * transitions over map node keys; the map supplies nodes and the commit.
 */
import type { MapNode } from "@tangent/client";
import { useCallback, useState } from "react";
import { candidateKeys, nodeAt, type Point } from "./relation-geometry";

export type LinkMode =
  | { kind: "idle" }
  | { kind: "dragging"; from: string; point: Point; over: string | null }
  | { kind: "targeting"; from: string; target: string | null }
  | { kind: "labeling"; from: string; to: string };

const IDLE: LinkMode = { kind: "idle" };

export interface RelationLinkOptions {
  nodes: readonly MapNode[];
  /** Keys already related to `key` (either direction): never offered as the other end. */
  relatedTo: (key: string) => ReadonlySet<string>;
}

export function useRelationLink({ nodes, relatedTo }: RelationLinkOptions) {
  const [mode, setMode] = useState<LinkMode>(IDLE);
  const droppable = useCallback((from: string, key: string | undefined | null) => Boolean(key) && key !== from && !relatedTo(from).has(key!), [relatedTo]);

  const cancel = useCallback(() => setMode(IDLE), []);
  const startDrag = useCallback((from: string, point: Point) => setMode({ kind: "dragging", from, point, over: null }), []);
  const moveDrag = useCallback(
    (point: Point) =>
      setMode((current) => {
        if (current.kind !== "dragging") return current;
        const over = nodeAt(nodes, point)?.key ?? null;
        return { ...current, point, over: droppable(current.from, over) ? over : null };
      }),
    [nodes, droppable],
  );
  /** Released: on a node that may be the other end → labeling; anywhere else → cancelled. */
  const endDrag = useCallback(
    (point: Point) =>
      setMode((current) => {
        if (current.kind !== "dragging") return current;
        const over = nodeAt(nodes, point)?.key;
        return droppable(current.from, over) ? { kind: "labeling", from: current.from, to: over! } : IDLE;
      }),
    [nodes, droppable],
  );
  const startTargeting = useCallback((from: string) => setMode({ kind: "targeting", from, target: null }), []);
  /** Arrow keys: the next / previous candidate, nearest first; returns the key now chosen. */
  const stepTarget = useCallback(
    (current: LinkMode, step: 1 | -1): string | null => {
      if (current.kind !== "targeting") return null;
      const keys = candidateKeys(nodes, current.from, relatedTo(current.from));
      if (keys.length === 0) return null;
      const index = current.target ? keys.indexOf(current.target) : -1;
      const next = keys[(index + step + keys.length) % keys.length] ?? null;
      setMode({ ...current, target: next });
      return next;
    },
    [nodes, relatedTo],
  );
  /** Enter on a candidate (or a press on it): labeling. */
  const choose = useCallback((key: string) => setMode((current) => (current.kind === "targeting" && droppable(current.from, key) ? { kind: "labeling", from: current.from, to: key } : current)), [droppable]);

  return { mode, cancel, startDrag, moveDrag, endDrag, startTargeting, stepTarget, choose };
}

export type RelationLink = ReturnType<typeof useRelationLink>;
