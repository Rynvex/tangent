import { classifyTermError, cleanTerm, cleanTermExplanation, DEFAULT_TERM_LIMITS, filterTerms, termInputProblem, type Term, type TermLimits } from "@tangent/client";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, CornerDownRight, PencilLine, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "../branch/error-alert";
import { Button } from "../components/button";
import { TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useUpdateTerm } from "../data/glossary-hooks";
import { useTerms } from "../data/glossary-query";
import { useGlossaryT } from "../i18n/glossary-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { restartTermDeletes, scheduleTermDelete, TERM_DELETE_UNDO_MS, undoTermDeletes, useHiddenTermIds, waitingTermDeletes } from "./pending-term-deletes";
import { TermFields, type TermDraft } from "./term-fields";

/** A toast with one action (the frame's). */
export type GlossaryToast = (message: string, action?: { label: string; run: () => void }, durationMs?: number) => void;

export interface GlossaryPanelProps {
  rootLineId: string;
  /** No editing or deleting (a viewer, or an archived conversation). */
  readOnly?: boolean;
  /** A term's source: the line and, when it has one, the message. */
  onGoToSource: (lineId: string, messageId?: string) => void;
  toast: GlossaryToast;
  /** A term to show open and scrolled to (asked from its underline in a reply); `n` makes each ask its own. */
  focus?: { termId: string; n: number } | null;
  className?: string;
}

type T = ReturnType<typeof useGlossaryT>;

/** The term's fields in place, saved with PATCH; a rename onto another term is said under them. */
function EditTerm({ term, limits, onDone }: { term: Term; limits: TermLimits; onDone: () => void }) {
  const t = useGlossaryT();
  const { hostErrorText } = useTangent();
  const update = useUpdateTerm();
  const [draft, setDraft] = useState<TermDraft>({ term: term.term, explanation: term.explanation });
  const [tried, setTried] = useState(false);
  const failure = update.error ? classifyTermError(update.error) : null;
  const save = () => {
    setTried(true);
    if (termInputProblem(draft, limits) || update.isPending) return;
    const name = cleanTerm(draft.term);
    const explanation = cleanTermExplanation(draft.explanation);
    const input = { ...(name !== term.term ? { term: name } : {}), ...(explanation !== term.explanation ? { explanation } : {}) };
    if (Object.keys(input).length === 0) return onDone();
    update.mutate({ termId: term.id, input }, { onSuccess: onDone });
  };
  return (
    <form
      aria-label={t("glossary.editTitle", { term: term.term })}
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <TermFields value={draft} onChange={setDraft} limits={limits} tried={tried} rows={5} />
      {failure && (
        <ErrorAlert>
          {failure.kind === "exists"
            ? t("glossary.exists", { term: failure.existing?.term ?? cleanTerm(draft.term) })
            : failure.kind === "archived"
              ? t("glossary.archived")
              : failure.kind === "gone"
                ? t("glossary.gone")
                : t("glossary.failed", { reason: describeError(update.error, t, hostErrorText) })}
        </ErrorAlert>
      )}
      <span className="flex justify-end gap-2">
        <Button size="sm" onClick={onDone}>
          {t("glossary.cancel")}
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={update.isPending}>
          {t("glossary.saveEdit")}
        </Button>
      </span>
    </form>
  );
}

/** Where the term came from: the way there while its line exists, else the name it had (a snapshot). */
function TermSource({ term, t, onGo }: { term: Term; t: T; onGo: GlossaryPanelProps["onGoToSource"] }) {
  if (!term.sourceLabel && !term.sourceLineId) return null;
  const label = term.sourceLabel || t("glossary.source");
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-tg-xs text-tg-muted">
      <CornerDownRight aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">{t("glossary.source")}</span>
      {term.sourceLineId ? (
        <button
          type="button"
          aria-label={t("glossary.goSource", { term: term.term, label })}
          onClick={() => onGo(term.sourceLineId, term.sourceMessageId || undefined)}
          className="min-w-0 truncate rounded-tg-sm text-left text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
        >
          {label}
        </button>
      ) : (
        <span data-tg-term-source-gone="" className="min-w-0 truncate">
          {t("glossary.sourceDeleted", { label })}
        </span>
      )}
    </span>
  );
}

interface RowProps {
  term: Term;
  open: boolean;
  editing: boolean;
  limits: TermLimits;
  readOnly: boolean;
  onToggle: () => void;
  onEdit: (editing: boolean) => void;
  onDelete: () => void;
  onGoToSource: GlossaryPanelProps["onGoToSource"];
}

function TermRow({ term, open, editing, limits, readOnly, onToggle, onEdit, onDelete, onGoToSource }: RowProps) {
  const t = useGlossaryT();
  return (
    <li data-tg-term={term.id} className={cx("flex flex-col rounded-tg-sm", open && "bg-tg-surface-sunken")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 items-baseline gap-2 rounded-tg-sm px-2 py-1.5 text-left hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
      >
        <ChevronRight aria-hidden className={cx("size-3.5 shrink-0 self-center text-tg-muted transition-transform duration-(--tg-duration-fast)", open && "rotate-90")} />
        <span className="shrink-0 text-tg-sm font-semibold text-tg-foreground-strong">{term.term}</span>
        {!open && <span className="min-w-0 flex-1 truncate text-tg-xs text-tg-muted">{term.explanation}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-2 pt-0.5 pb-2.5 pl-7.5">
          {editing ? (
            <EditTerm term={term} limits={limits} onDone={() => onEdit(false)} />
          ) : (
            <>
              <p className="m-0 text-tg-sm whitespace-pre-wrap text-tg-foreground">{term.explanation}</p>
              <TermSource term={term} t={t} onGo={onGoToSource} />
              {!readOnly && (
                <span className="flex gap-1.5">
                  <Button size="sm" icon={<PencilLine aria-hidden className="size-3" />} onClick={() => onEdit(true)}>
                    {t("glossary.edit")}
                  </Button>
                  <Button size="sm" icon={<Trash2 aria-hidden className="size-3" />} aria-label={t("glossary.deleteTerm", { term: term.term })} onClick={onDelete}>
                    {t("glossary.delete")}
                  </Button>
                </span>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The side panel's 名詞表 (F19 §2.2): the conversation's terms by name, a
 * filter over them, each one opening to its explanation, where it came from
 * and 編輯 / 刪除. A delete hides the term and is sent five seconds later;
 * 復原 in the toast takes back every delete still waiting. Empty, it says
 * in one line what belongs here.
 */
export default function GlossaryPanel({ rootLineId, readOnly = false, onGoToSource, toast, focus, className }: GlossaryPanelProps) {
  const t = useGlossaryT();
  const ctx = useTangent();
  const queryClient = useQueryClient();
  const terms = useTerms(rootLineId);
  const hidden = useHiddenTermIds();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const all = useMemo(() => (terms.data?.terms ?? []).filter((term) => !hidden.has(term.id)), [terms.data, hidden]);
  const shown = useMemo(() => filterTerms(all, query), [all, query]);
  const limits = terms.data?.limits ?? DEFAULT_TERM_LIMITS;

  // A term asked for from a reply: shown whatever the filter says, open, and in view.
  const focused = useRef(0);
  useEffect(() => {
    if (!focus || focus.n === focused.current || !terms.data) return;
    focused.current = focus.n;
    setQuery("");
    setEditingId(null);
    setOpenId(focus.termId);
    requestAnimationFrame(() => {
      const row = list.current?.querySelector<HTMLElement>(`[data-tg-term="${CSS.escape(focus.termId)}"]`);
      // Not every host has it (an old webview, a test's DOM): the row is still opened and focused.
      row?.scrollIntoView?.({ block: "nearest" });
      row?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    });
  }, [focus, terms.data]);

  // What the waits need when they end is read then, not now.
  const latest = useRef({ t, toast, hostErrorText: ctx.hostErrorText });
  latest.current = { t, toast, hostErrorText: ctx.hostErrorText };
  const remove = (term: Term) => {
    scheduleTermDelete(term, {
      client: ctx.client,
      queryClient,
      keys: ctx.keys,
      onRefused: (refused, error) => {
        const now = latest.current;
        const failure = classifyTermError(error);
        now.toast(failure.kind === "archived" ? now.t("glossary.archived") : now.t("glossary.deleteFailed", { term: refused.term, reason: describeError(error, now.t, now.hostErrorText) }));
      },
    });
    // One toast for every delete still waiting: they all get the full time again, and one 復原 brings them all back.
    restartTermDeletes();
    const count = waitingTermDeletes().length;
    if (openId === term.id) setOpenId(null);
    toast(
      count > 1 ? t("glossary.deletedMany", { n: count }) : t("glossary.deleted", { term: term.term }),
      {
        label: t("glossary.undo"),
        run: () => {
          if (undoTermDeletes().length > 0) latest.current.toast(latest.current.t("glossary.undone"));
        },
      },
      TERM_DELETE_UNDO_MS,
    );
  };

  if (terms.isError) {
    return (
      <div role="alert" className={cx("flex flex-col items-start gap-2 p-3 text-tg-sm text-tg-muted", className)}>
        {t("glossary.loadFailed")}
        <Button size="sm" onClick={() => void terms.refetch()}>
          {t("glossary.retry")}
        </Button>
      </div>
    );
  }
  if (!terms.data) return <div role="status" aria-label={t("ui.loading")} className={cx("p-3", className)} />;
  if (all.length === 0) {
    return (
      <p data-tg-glossary-empty="" className={cx("m-0 p-3 text-tg-sm text-tg-muted", className)}>
        {t("glossary.empty")}
      </p>
    );
  }
  return (
    <section aria-label={t("glossary.name")} className={cx("flex min-h-0 flex-col gap-2 p-3", className)}>
      <TextField label={t("glossary.filter")} type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      {shown.length === 0 ? (
        <p className="m-0 text-tg-sm text-tg-muted">{t("glossary.noMatch", { q: query.trim() })}</p>
      ) : (
        <ul ref={list} className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map((term) => (
            <TermRow
              key={term.id}
              term={term}
              open={openId === term.id}
              editing={editingId === term.id}
              limits={limits}
              readOnly={readOnly}
              onToggle={() => {
                setEditingId(null);
                setOpenId(openId === term.id ? null : term.id);
              }}
              onEdit={(editing) => setEditingId(editing ? term.id : null)}
              onDelete={() => remove(term)}
              onGoToSource={onGoToSource}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
