import { isFeatureOn, relationSuggestionOf, type Link, type Suggestion } from "@tangent/client";
import { Link2, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { INPUT_SURFACE } from "../components/text-field";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import { useAcceptSuggestion, useDismissSuggestion, useSuggestions } from "../data/p1-hooks";
import { useCreateRelation, useDeleteRelation, useRelations, useUpdateRelation } from "../data/p2-hooks";
import { useCapabilities } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { farEnd, useLineNames, type InTree, type LineNamer } from "./line-names";
import { RelationKindChip, RelationKindPicker, relationKindOf } from "./relation-kinds";

/** How long a deleted relation can be brought back (interactions: 5 秒內可復原). */
export const RELATION_UNDO_MS = 5000;

export interface RelationListProps {
  rootLineId: string;
  /** Goes to a line (another conversation's too), at a message when the end is one. */
  onGo: (lineId: string, messageId?: string) => void;
  /** 新增關聯: the host opens the relation dialog from the line on screen. */
  onAdd: () => void;
  /** Only relations (and AI proposals) with an end on this line (focus mode's node panel); nothing for a viewer when there are none. */
  lineId?: string;
  /** Nothing at all while there is no relation and no proposal (F19 §4); the host keeps another way to add one. */
  hideWhenEmpty?: boolean;
  className?: string;
}

function End({ lineId, messageId, title, name, onGo }: { lineId: string; messageId: string; title: string; name: LineNamer; onGo: RelationListProps["onGo"] }) {
  const t = useP2T();
  const label = name(lineId, title);
  return (
    <button
      type="button"
      aria-label={t("relation.go", { title: label })}
      onClick={() => onGo(lineId, messageId || undefined)}
      className="min-w-0 truncate rounded-tg-sm text-left text-tg-primary-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
    >
      {label}
    </button>
  );
}

/** 改說明 in place: Enter saves (B9 phase C `PATCH`), Esc leaves the note as it was; the kind (B15) saves as soon as it is picked. */
function NoteEditor({ rootLineId, link, onDone }: { rootLineId: string; link: Link; onDone: () => void }) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const update = useUpdateRelation(rootLineId);
  const [error, setError] = useState<string | null>(null);
  const failed = (failure: unknown) => setError(t("relation.failed", { reason: describeError(failure, t, hostErrorText) }));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const label = event.currentTarget.value.trim();
    if (label === link.label) return onDone();
    update.mutateAsync({ relationId: link.id, label }).then(onDone, failed);
  };
  return (
    <span className="flex flex-col gap-1">
      <RelationKindPicker
        value={relationKindOf(link)}
        onValueChange={(relationKind) => {
          setError(null);
          if (relationKind !== relationKindOf(link)) update.mutateAsync({ relationId: link.id, relationKind }).catch(failed);
        }}
        className="self-start"
      />
      <input autoFocus aria-label={t("relation.noteField")} defaultValue={link.label} maxLength={200} onKeyDown={onKeyDown} className={cx(INPUT_SURFACE, "h-7 px-2 text-tg-xs")} />
      {error && (
        <span role="alert" className="text-tg-xs text-tg-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** The other end first when the stored start is in another tree, so a re-created relation starts here. */
function startHere(link: Link, inTree: InTree) {
  const swap = !inTree(link.fromLineId);
  const [from, to] = swap ? [[link.toLineId, link.toMessageId], [link.fromLineId, link.fromMessageId]] : [[link.fromLineId, link.fromMessageId], [link.toLineId, link.toMessageId]];
  return { fromLineId: from[0]!, ...(from[1] ? { fromMessageId: from[1] } : {}), toLineId: to[0]!, ...(to[1] ? { toMessageId: to[1] } : {}), ...(link.label ? { label: link.label } : {}), ...(link.relationKind && link.relationKind !== "related" ? { relationKind: link.relationKind } : {}) };
}

/** A deletion that can be undone for RELATION_UNDO_MS; undo makes the same relation again. */
function useUndoableDelete(rootLineId: string, inTree: InTree) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const remove = useDeleteRelation(rootLineId);
  const create = useCreateRelation(rootLineId);
  const [deleted, setDeleted] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!deleted) return;
    const timer = setTimeout(() => setDeleted(null), RELATION_UNDO_MS);
    return () => clearTimeout(timer);
  }, [deleted]);
  const failed = (failure: unknown) => setError(t("relation.failed", { reason: describeError(failure, t, hostErrorText) }));
  return {
    deleted,
    error,
    remove: (link: Link) => {
      setError(null);
      const far = farEnd(link, inTree);
      remove.mutateAsync({ relationId: link.id, ...(far ? { otherLineId: far } : {}) }).then(() => setDeleted(link), failed);
    },
    undo: () => {
      if (!deleted) return;
      const link = deleted;
      setDeleted(null);
      create.mutateAsync(startHere(link, inTree)).catch(failed);
    },
  };
}

function SuggestedItem({ rootLineId, suggestion, readOnly }: { rootLineId: string; suggestion: Suggestion; readOnly: boolean }) {
  const t = useP2T();
  const accept = useAcceptSuggestion(rootLineId);
  const dismiss = useDismissSuggestion(rootLineId);
  const proposal = relationSuggestionOf(suggestion);
  if (!proposal) return null;
  const text = t("relation.item", { from: proposal.fromTitle, to: proposal.toTitle });
  return (
    <li aria-label={`${t("relation.suggested")}：${text}`} className="flex flex-col gap-1.5 rounded-tg-sm border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2.5 py-2">
      <span className="text-tg-xs font-semibold text-tg-suggestion">{t("relation.suggested")}</span>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-tg-sm break-words text-tg-foreground">
        {text}
        <RelationKindChip kind={proposal.relationKind} />
      </span>
      {proposal.label && <span className="text-tg-xs break-words text-tg-muted">{proposal.label}</span>}
      {!readOnly && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="primary" loading={accept.isPending} onClick={() => void accept.mutateAsync({ suggestionId: suggestion.id }).catch(() => undefined)}>
            {t("relation.confirm")}
          </Button>
          <Button size="sm" variant="ghost" loading={dismiss.isPending} onClick={() => void dismiss.mutateAsync({ suggestionId: suggestion.id }).catch(() => undefined)}>
            {t("relation.remove")}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The tree's relations under the outline (C3; the keyboard and narrow-width
 * way to see, follow, add and delete them): each end jumps there — another
 * conversation's too — and AI's proposals sit dashed, to confirm or remove.
 * Rendered only while the relations feature is on.
 */
export function RelationList({ rootLineId, onGo, onAdd, lineId, hideWhenEmpty = false, className }: RelationListProps) {
  const t = useP2T();
  const headingId = useId();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const relations = useRelations(rootLineId);
  const suggestions = useSuggestions(rootLineId, isFeatureOn(capabilities.data, "suggestions"));
  const { name, inTree } = useLineNames(rootLineId);
  const undoable = useUndoableDelete(rootLineId, inTree);
  const [editing, setEditing] = useState<string | null>(null);
  const touches = (ends: { fromLineId: string; toLineId: string } | null) => ends !== null && (lineId === undefined || ends.fromLineId === lineId || ends.toLineId === lineId);
  const items = (relations.data?.relations ?? []).filter(touches);
  const proposed = (suggestions.data?.suggestions ?? []).filter((item) => item.status === "open" && touches(relationSuggestionOf(item)));
  if (lineId !== undefined && readOnly && items.length === 0 && proposed.length === 0) return null;
  if (hideWhenEmpty && items.length === 0 && proposed.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5">
        <h3 id={headingId} className="m-0 flex flex-1 items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
          <Link2 aria-hidden className="size-3.25" />
          {t("relation.title")}
          <span className="font-normal text-tg-subtle">{t("relation.count", { count: items.length })}</span>
        </h3>
        {!readOnly && (
          <Button size="sm" variant="ghost" icon={<Plus aria-hidden className="size-3" />} onClick={onAdd}>
            {t("relation.add")}
          </Button>
        )}
      </div>
      {items.length === 0 && proposed.length === 0 && relations.isSuccess && <p className="m-0 px-1 text-tg-xs text-tg-muted">{t("relation.empty")}</p>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((link) => {
          const from = name(link.fromLineId, link.fromTitle);
          const to = name(link.toLineId, link.toTitle);
          return (
            <li key={link.id} className="group flex items-start gap-1.5 rounded-tg-sm border border-tg-border px-2.5 py-1.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1 text-tg-sm">
                  <End lineId={link.fromLineId} messageId={link.fromMessageId} title={link.fromTitle} name={name} onGo={onGo} />
                  <span aria-hidden className="text-tg-subtle">
                    –
                  </span>
                  <End lineId={link.toLineId} messageId={link.toMessageId} title={link.toTitle} name={name} onGo={onGo} />
                  <RelationKindChip kind={relationKindOf(link)} />
                </span>
                {editing === link.id ? (
                  <NoteEditor rootLineId={rootLineId} link={link} onDone={() => setEditing(null)} />
                ) : (
                  link.label && <span className="text-tg-xs break-words text-tg-muted">{link.label}</span>
                )}
              </div>
              {!readOnly && editing !== link.id && <IconButton label={t("relation.editNote")} icon={<Pencil />} size="sm" onClick={() => setEditing(link.id)} />}
              {!readOnly && <IconButton label={t("relation.delete", { from, to })} icon={<Trash2 />} size="sm" onClick={() => undoable.remove(link)} />}
            </li>
          );
        })}
        {proposed.map((suggestion) => (
          <SuggestedItem key={suggestion.id} rootLineId={rootLineId} suggestion={suggestion} readOnly={readOnly} />
        ))}
      </ul>
      <div role="status" className="text-tg-xs text-tg-muted">
        {undoable.deleted && (
          <span className="flex items-center gap-2">
            {t("relation.deleted")}
            <Button size="sm" variant="ghost" onClick={undoable.undo}>
              {t("relation.undo")}
            </Button>
          </span>
        )}
      </div>
      {undoable.error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {undoable.error}
        </p>
      )}
    </section>
  );
}
