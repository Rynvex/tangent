/**
 * The map's relation layer (C3): committed relations as solid curves with
 * their note, AI's as dashed `--tg-suggestion` curves to confirm or remove,
 * the line being dragged and the note being written. Each kind of
 * information keeps its own channel (handoff §9-7); nothing here moves a node.
 */
import type { DrawnRelation, Link, MapLayout, Suggestion } from "@tangent/client";
import { Link2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { useP2T } from "../i18n/p2-messages";
import { cx } from "../lib/cx";
import { dragLine, relationCurve, type Point } from "./relation-geometry";
import type { LinkMode } from "./use-relation-link";

/** What the host gives the map to show and change relations; the map stays free of data fetching. */
export interface MapRelationsProps {
  /** The tree's relations (`GET /relations`); ones reaching another conversation are listed outside the map. */
  relations: readonly Link[];
  /** Open `relation` suggestions (AI's, dashed until confirmed). */
  suggestions: readonly Suggestion[];
  readOnly: boolean;
  /** Made as soon as the other end is chosen (drop or Enter); the note follows (B9 phase C `PATCH`). */
  onCreate: (fromLineId: string, toLineId: string) => Promise<Link>;
  /** 寫說明 after making it, and 改說明 on a selected relation. */
  onUpdateLabel: (relation: Link, label: string) => Promise<unknown>;
  onDelete: (relation: Link) => Promise<unknown>;
  /** Makes a deleted relation again (interactions: 5 秒內可復原). */
  onUndoDelete: (relation: Link) => Promise<unknown>;
  onAccept: (suggestion: Suggestion) => Promise<unknown>;
  onDismiss: (suggestion: Suggestion) => Promise<unknown>;
  describeFailure: (error: unknown) => string;
}

/** A suggested relation whose both ends are on the map. */
export interface DrawnSuggestion {
  suggestion: Suggestion;
  from: string;
  to: string;
  label: string;
}

/** How long a deleted relation can be brought back. */
export const MAP_RELATION_UNDO_MS = 5000;

export function RelationLines({ layout, drawn, suggested, mode }: { layout: MapLayout; drawn: readonly DrawnRelation[]; suggested: readonly DrawnSuggestion[]; mode: LinkMode }) {
  const node = (key: string) => layout.byKey.get(key);
  const dragFrom = mode.kind === "dragging" ? node(mode.from) : undefined;
  const pending = mode.kind === "labeling" ? [node(mode.from), node(mode.to)] : null;
  return (
    <svg aria-hidden width={layout.width} height={layout.height} className="pointer-events-none absolute inset-0 overflow-visible">
      {drawn.map(({ relation, from, to }) => {
        const a = node(from);
        const b = node(to);
        return a && b ? <path key={relation.id} data-tg-relation={relation.id} d={relationCurve(a, b).d} fill="none" strokeWidth={1.5} className="stroke-tg-foreground" /> : null;
      })}
      {suggested.map(({ suggestion, from, to }) => {
        const a = node(from);
        const b = node(to);
        return a && b ? (
          <path key={suggestion.id} data-tg-relation-suggested={suggestion.id} d={relationCurve(a, b).d} fill="none" strokeWidth={1.5} strokeDasharray="5 4" className="stroke-tg-suggestion" />
        ) : null;
      })}
      {dragFrom && mode.kind === "dragging" && <path data-tg-drag-line="" d={dragLine(dragFrom, mode.point)} fill="none" strokeWidth={1.5} strokeDasharray="4 3" className="stroke-tg-primary" />}
      {pending?.[0] && pending[1] && <path d={relationCurve(pending[0], pending[1]).d} fill="none" strokeWidth={1.5} strokeDasharray="4 3" className="stroke-tg-primary" />}
    </svg>
  );
}

const PILL = "absolute z-10";

function noteTransform(zoom: number): string {
  return zoom < 1 ? `translate(-50%, -50%) scale(${1 / zoom})` : "translate(-50%, -50%)";
}

/**
 * The note being written: after a drop or Enter (the relation already
 * exists; Esc or leaving it keeps it without a note), or 改說明 on a
 * selected one (Esc keeps the old note).
 */
function LabelInput({ at, zoom = 1, initial = "", onCommit, onCancel }: { at: Point; zoom?: number; initial?: string; onCommit: (label: string) => void; onCancel?: () => void }) {
  const t = useP2T();
  const done = useRef(false);
  const commit = (label: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(label.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") commit(event.currentTarget.value);
    else if (event.key === "Escape") {
      if (onCancel) {
        done.current = true;
        onCancel();
      } else commit("");
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <input
      // The one place the map takes focus: the user just dropped a relation and writes its note.
      autoFocus
      aria-label={t("relation.labelInput")}
      defaultValue={initial}
      maxLength={200}
      onKeyDown={onKeyDown}
      onBlur={(event) => commit(event.currentTarget.value)}
      onPointerDown={(event) => event.stopPropagation()}
      style={{ left: at.x, top: at.y, transform: noteTransform(zoom) }}
      className={cx(PILL, "h-8 w-56 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-tg-xs text-tg-foreground shadow-tg-overlay focus-visible:outline-2 focus-visible:outline-tg-ring")}
    />
  );
}

export interface RelationNotesProps {
  layout: MapLayout;
  drawn: readonly DrawnRelation[];
  suggested: readonly DrawnSuggestion[];
  mode: LinkMode;
  readOnly: boolean;
  /** The map's zoom: pills and suggestion buttons stay at least 1× so targets never shrink below 24 px (WCAG 2.5.8). */
  zoom?: number;
  name: (key: string) => string;
  onCommit: (label: string) => void;
  onDelete: (relation: Link) => void;
  onEditLabel: (relation: Link, label: string) => void;
  onAccept: (suggestion: Suggestion) => void;
  onDismiss: (suggestion: Suggestion) => void;
}

/** The notes on the curves (selectable, Delete removes), AI's proposals with confirm / remove, and the note input. */
export function RelationNotes({ layout, drawn, suggested, mode, readOnly, zoom = 1, name, onCommit, onDelete, onEditLabel, onAccept, onDismiss }: RelationNotesProps) {
  const t = useP2T();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const transform = noteTransform(zoom);
  const mid = (from: string, to: string) => {
    const a = layout.byKey.get(from);
    const b = layout.byKey.get(to);
    return a && b ? relationCurve(a, b).mid : null;
  };
  const labeling = mode.kind === "labeling" ? mid(mode.from, mode.to) : null;
  return (
    <>
      {drawn.map(({ relation, from, to }) => {
        const at = mid(from, to);
        if (!at) return null;
        const names = { from: name(from), to: name(to) };
        const remove = () => !readOnly && onDelete(relation);
        if (editing === relation.id) {
          return (
            <LabelInput
              key={relation.id}
              at={at}
              zoom={zoom}
              initial={relation.label}
              onCommit={(label) => {
                setEditing(null);
                if (label !== relation.label) onEditLabel(relation, label);
              }}
              onCancel={() => setEditing(null)}
            />
          );
        }
        return (
          <div key={relation.id} style={{ left: at.x, top: at.y, transform }} className={cx(PILL, "flex items-center gap-0.5")}>
            <button
              type="button"
              aria-label={t("relation.select", { ...names, label: relation.label ? `: ${relation.label}` : "" })}
              aria-pressed={selected === relation.id}
              onClick={() => setSelected((current) => (current === relation.id ? null : relation.id))}
              onKeyDown={(event) => {
                if (event.key !== "Delete" && event.key !== "Backspace") return;
                event.preventDefault();
                remove();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="flex h-6 min-w-6 max-w-44 items-center justify-center gap-1 rounded-tg-full border border-tg-border-strong bg-tg-surface-raised px-2 text-[0.6875rem] text-tg-foreground shadow-tg hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring aria-pressed:border-tg-ring"
            >
              {relation.label ? <span className="truncate">{relation.label}</span> : <Link2 aria-hidden className="size-3" />}
            </button>
            {selected === relation.id && !readOnly && (
              <>
                <IconButton label={t("relation.editNote")} icon={<Pencil />} size="sm" tooltip={false} onClick={() => setEditing(relation.id)} />
                <IconButton label={t("relation.delete", names)} icon={<Trash2 />} size="sm" tooltip={false} onClick={remove} />
              </>
            )}
          </div>
        );
      })}
      {suggested.map(({ suggestion, from, to, label }) => {
        const at = mid(from, to);
        if (!at) return null;
        return (
          <div
            key={suggestion.id}
            role="group"
            aria-label={`${t("relation.suggested")}: ${t("relation.item", { from: name(from), to: name(to) })}`}
            onPointerDown={(event) => event.stopPropagation()}
            style={{ left: at.x, top: at.y, transform }}
            className={cx(PILL, "flex w-44 flex-col gap-1 rounded-tg-sm border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2 py-1.5 text-[0.6875rem]")}
          >
            <span className="font-semibold text-tg-suggestion">{t("relation.suggested")}</span>
            {label && <span className="break-words text-tg-foreground">{label}</span>}
            {!readOnly && (
              <span className="flex gap-1">
                <Button size="sm" variant="primary" onClick={() => onAccept(suggestion)}>
                  {t("relation.confirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onDismiss(suggestion)}>
                  {t("relation.remove")}
                </Button>
              </span>
            )}
          </div>
        );
      })}
      {labeling && <LabelInput at={labeling} zoom={zoom} onCommit={onCommit} />}
    </>
  );
}

/** A deletion that can be undone for a while, and the last failure; for the status row under the map. */
export function useRelationDeletion(relations: MapRelationsProps | undefined) {
  const [deleted, setDeleted] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), MAP_RELATION_UNDO_MS);
    return () => clearTimeout(timer);
  }, [deleted]);
  const run = (write: () => Promise<unknown>, then?: () => void) => {
    setError(null);
    write().then(then, (failure: unknown) => setError(relations?.describeFailure(failure) ?? String(failure)));
  };
  return {
    deleted,
    error,
    run,
    remove: (relation: Link) => relations && run(() => relations.onDelete(relation), () => setDeleted(relation)),
    undo: () => {
      if (!relations || !deleted) return;
      const relation = deleted;
      setDeleted(null);
      run(() => relations.onUndoDelete(relation));
    },
  };
}

export function RelationStatus({ mode, fromName, deleted, error, onUndo }: { mode: LinkMode; fromName: string; deleted: boolean; error: string | null; onUndo: () => void }) {
  const t = useP2T();
  return (
    <div role="status" aria-label={t("relation.status")} className="flex min-h-5 flex-wrap items-center gap-2 px-1 text-tg-xs text-tg-muted">
      {mode.kind === "targeting" && <span>{t("relation.targeting", { title: fromName })}</span>}
      {mode.kind === "labeling" && <span>{t("relation.labeling")}</span>}
      {deleted && mode.kind === "idle" && (
        <>
          <span>{t("relation.deleted")}</span>
          <Button size="sm" variant="ghost" onClick={onUndo}>
            {t("relation.undo")}
          </Button>
        </>
      )}
      {error && <span className="text-tg-destructive">{error}</span>}
    </div>
  );
}

/** Where the map remembers that its how-to was shown once (this browser). */
export const MAP_HINT_SEEN_KEY = "tangent:map-relation-hint:v1";

function hintSeen(): boolean {
  try {
    return window.localStorage.getItem(MAP_HINT_SEEN_KEY) !== null;
  } catch {
    // No storage (a private window, a sandboxed embed): the hint keeps showing, as before.
    return false;
  }
}

/**
 * How to make a relation, under the map while nothing is being made (C3
 * prototype). F19 §4: only the first time a map is opened in this browser
 * (for as long as that map stays open); after that the map is left clean.
 */
export function RelationHint() {
  const t = useP2T();
  const [show] = useState(() => !hintSeen());
  useEffect(() => {
    if (!show) return;
    try {
      window.localStorage.setItem(MAP_HINT_SEEN_KEY, "1");
    } catch {
      // Nothing to remember it in.
    }
  }, [show]);
  if (!show) return null;
  return (
    <p data-tg-map-hint="" className="m-0 px-1 text-[0.6875rem] text-tg-subtle">
      {t("relation.mapHint")}
    </p>
  );
}
