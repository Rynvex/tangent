import {
  LEAF_BODY_MAX,
  LEAF_KINDS,
  LEAF_LINE_MAX,
  charCount,
  leafProblems,
  validateLeafLine,
  type FeatureMode,
  type Leaf as LeafData,
  type LeafInput,
  type LeafDraftError,
  type LeafKind,
} from "@tangent/client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { SegmentedControl } from "../components/segmented-control";
import { TextArea, TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useLeaf, usePutLeaf, useStartLeafDraft } from "../data/p1-hooks";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { useP1T } from "../i18n/p1-messages";
import { isComposing } from "../shortcuts/keys";
import { LEAF_KIND_KEYS, Leaf } from "./leaf";

export interface BranchLeafProps {
  /** An ended branch (or the previous main line). */
  lineId: string;
  /** The leaf feature's mode; "off" renders nothing. */
  mode: FeatureMode;
  readOnly?: boolean;
  className?: string;
}

interface FormProps {
  initial: LeafInput & { kind: LeafKind };
  pending: boolean;
  /** A refusal from the server: per field, or as a whole. */
  serverProblems: Partial<Record<"kind" | "line" | "body", string>>;
  failure: string | null;
  onSubmit: (input: LeafInput) => void;
  onCancel: () => void;
}

/** The edit form: kind, one line (Enter saves), details; Esc leaves it without saving or reaching the page. */
function LeafForm({ initial, pending, serverProblems, failure, onSubmit, onCancel }: FormProps) {
  const t = useP1T();
  const [kind, setKind] = useState<LeafKind>(initial.kind);
  const [line, setLine] = useState(initial.line);
  const [body, setBody] = useState(initial.body ?? "");
  const [tried, setTried] = useState(false);
  const lineBox = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const element = lineBox.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, []);
  const problem = validateLeafLine(line);
  const bodyTooLong = charCount(body) > LEAF_BODY_MAX;
  const lineError =
    problem === "tooLong" ? t("leaf.lineTooLong", { limit: LEAF_LINE_MAX }) : tried && problem === "empty" ? t("leaf.lineRequired") : (serverProblems.line ?? serverProblems.kind ?? null);
  const submit = () => {
    setTried(true);
    if (problem || bodyTooLong || pending) return;
    onSubmit({ kind, line: line.trim(), body: body.trim() });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event) || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  const onLineKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event) || event.key !== "Enter") return;
    event.preventDefault();
    submit();
  };
  return (
    <div role="group" aria-label={t("leaf.formLabel")} onKeyDown={onKeyDown} className="flex flex-col gap-2.5 rounded-tg-sm border border-tg-ring bg-tg-surface-raised p-2.5">
      <SegmentedControl label={t("leaf.kindLabel")} options={LEAF_KINDS.map((value) => ({ value, label: t(LEAF_KIND_KEYS[value]) }))} value={kind} onValueChange={setKind} />
      <TextField
        ref={lineBox}
        label={
          <span className="flex justify-between gap-2">
            {t("leaf.lineLabel")}
            <span className="font-tg-mono text-tg-xs font-normal text-tg-subtle">{t("leaf.lineCount", { count: charCount(line.trim()), limit: LEAF_LINE_MAX })}</span>
          </span>
        }
        value={line}
        error={lineError}
        aria-invalid={lineError ? true : undefined}
        onChange={(event) => setLine(event.target.value)}
        onKeyDown={onLineKey}
      />
      <TextArea
        label={t("leaf.bodyLabel")}
        rows={3}
        value={body}
        error={bodyTooLong ? t("leaf.bodyTooLong", { limit: LEAF_BODY_MAX }) : (serverProblems.body ?? null)}
        onChange={(event) => setBody(event.target.value)}
      />
      {failure && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("leaf.cancel")}
        </Button>
        <Button size="sm" variant="primary" loading={pending} onClick={submit}>
          {t("leaf.save")}
        </Button>
      </div>
    </div>
  );
}

function LeafBody({ body }: { body: string }) {
  const t = useP1T();
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!body) return null;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-0.5 self-start text-tg-xs text-tg-muted hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
      >
        {open ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
        {open ? t("leaf.hideBody") : t("leaf.showBody")}
      </button>
      {open && (
        <p id={id} className="m-0 text-tg-xs whitespace-pre-wrap text-tg-foreground">
          {body}
        </p>
      )}
    </>
  );
}

type Editing = { initial: LeafInput & { kind: LeafKind } } | null;

const DRAFT_ERROR_KEYS = {
  run_failed: "leaf.draftError.run_failed",
  unusable: "leaf.draftError.unusable",
  timed_out: "leaf.draftError.timed_out",
  failed: "leaf.draftError.failed",
} as const satisfies Record<LeafDraftError["code"], string>;

/** Brings focus back to the edit button once a form closes and focus was left nowhere. */
function useRefocus(editing: Editing) {
  const target = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  useLayoutEffect(() => {
    if (editing || !pending.current) return;
    pending.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) target.current?.focus();
  }, [editing]);
  return { target, arm: () => (pending.current = true) };
}

interface LeafActionsProps {
  leaf: LeafData | null;
  waiting: boolean;
  saving: boolean;
  drafting: boolean;
  /** False while a failed draft offers its own retry. */
  canAskDraft: boolean;
  editRef: RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onEdit: () => void;
  onAskDraft: () => void;
}

/** Confirm a draft, edit (or write) the leaf, or ask AI for one when there is none. */
function LeafActions({ leaf, waiting, saving, drafting, canAskDraft, editRef, onConfirm, onEdit, onAskDraft }: LeafActionsProps) {
  const t = useP1T();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {leaf?.status === "draft" && (
        <Button size="sm" variant="primary" loading={saving} onClick={onConfirm}>
          {t("leaf.confirm")}
        </Button>
      )}
      <Button ref={editRef} size="sm" onClick={onEdit}>
        {leaf ? t("leaf.edit") : t("leaf.write")}
      </Button>
      {!leaf && !waiting && canAskDraft && (
        <Button size="sm" variant="ghost" loading={drafting} onClick={onAskDraft}>
          {t("leaf.askDraft")}
        </Button>
      )}
    </div>
  );
}

/** The leaf's writes and their states: the open form, the server's reasons, a draft on its way. */
function useLeafEditing(lineId: string, leaf: LeafData | null, draftError: LeafDraftError | undefined) {
  const t = useP1T();
  const { hostErrorText } = useTangent();
  const put = usePutLeaf(lineId);
  const draft = useStartLeafDraft(lineId);
  const [editing, setEditing] = useState<Editing>(null);
  const [problems, setProblems] = useState<FormProps["serverProblems"]>({});
  const [failure, setFailure] = useState<string | null>(null);
  /** While a draft is on its way: the leaf's `updatedAt` when it was asked for ("" for none). */
  const [waitingFrom, setWaitingFrom] = useState<string | null>(null);
  const focus = useRefocus(editing);
  // The wait ends with a new leaf, or with the draft's failure (B8.1 draftError).
  if (waitingFrom !== null && ((leaf?.updatedAt ?? "") !== waitingFrom || draftError)) setWaitingFrom(null);
  const reason = (error: unknown) => describeError(error, t, hostErrorText);
  const close = () => {
    focus.arm();
    setEditing(null);
    setProblems({});
  };
  return {
    put,
    draft,
    editing,
    problems,
    failure,
    waiting: waitingFrom !== null,
    focus,
    open: () => setEditing({ initial: leaf ?? { kind: "conclusion", line: "", body: "" } }),
    cancel: () => {
      close();
      setFailure(null);
    },
    save: (input: LeafInput) => {
      setFailure(null);
      put.mutate(input, {
        onSuccess: close,
        onError: (error) => {
          const fields = leafProblems(error);
          setProblems(fields);
          if (Object.keys(fields).length === 0) setFailure(t("leaf.failed", { reason: reason(error) }));
          if (!editing && leaf) setEditing({ initial: leaf });
        },
      });
    },
    askDraft: () => {
      setFailure(null);
      draft.mutate(undefined, {
        onSuccess: () => setWaitingFrom(leaf?.updatedAt ?? ""),
        onError: (error) => setFailure(t("leaf.draftFailed", { reason: reason(error) })),
      });
    },
  };
}

/**
 * An ended branch's leaf (B1, on the branch bar): the leaf with its details,
 * and — unless read-only — edit (kind, one line, details) and confirm, or for
 * a branch without one, write it or ask AI for a draft (the only way in
 * manual mode). An AI draft is dashed and confirmed with one press; a leaf AI
 * made in auto mode is marked and can be edited like any other.
 */
export function BranchLeaf({ lineId, mode, readOnly = false, className }: BranchLeafProps) {
  const t = useP1T();
  const query = useLeaf(lineId, mode !== "off");
  const leaf: LeafData | null = query.data?.leaf ?? null;
  const draftError = query.data?.draftError;
  const edit = useLeafEditing(lineId, leaf, draftError);
  if (mode === "off") return null;
  const { editing } = edit;
  return (
    <section aria-label={t("leaf.regionLabel")} className={cx("flex flex-col gap-1.5 pl-1", className)}>
      {query.isPending && <Skeleton className="h-4 w-[60%]" />}
      {leaf && !editing && (
        <>
          <Leaf leaf={leaf} showKind wrap />
          <LeafBody body={leaf.body} />
        </>
      )}
      {query.isSuccess && !leaf && !editing && <span className="text-tg-xs text-tg-muted">{t("leaf.none")}</span>}
      {edit.waiting && (
        <span role="status" className="text-tg-xs text-tg-muted">
          {t("leaf.drafting")}
        </span>
      )}
      {editing && <LeafForm initial={editing.initial} pending={edit.put.isPending} serverProblems={edit.problems} failure={edit.failure} onSubmit={edit.save} onCancel={edit.cancel} />}
      {!editing && !edit.waiting && draftError && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-2 text-tg-xs text-tg-destructive">
          {t("leaf.draftError", { reason: t(DRAFT_ERROR_KEYS[draftError.code]) })}
          {!readOnly && (
            <Button size="sm" variant="ghost" loading={edit.draft.isPending} onClick={edit.askDraft}>
              {t("leaf.retryDraft")}
            </Button>
          )}
        </p>
      )}
      {!editing && edit.failure && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {edit.failure}
        </p>
      )}
      {!readOnly && !editing && query.isSuccess && (
        <LeafActions
          leaf={leaf}
          waiting={edit.waiting}
          saving={edit.put.isPending}
          drafting={edit.draft.isPending}
          canAskDraft={!draftError}
          editRef={edit.focus.target}
          onConfirm={() => leaf && edit.save({ kind: leaf.kind, line: leaf.line, body: leaf.body })}
          onEdit={edit.open}
          onAskDraft={edit.askDraft}
        />
      )}
    </section>
  );
}
