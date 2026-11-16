import { Working } from "../components/working";
import type { Fold } from "@tangent/client";
import { ChevronDown, ChevronRight, FoldVertical, Pencil, UnfoldVertical } from "lucide-react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/button";
import { DEFAULT_FOLD_LIMITS } from "@tangent/client";
import { IconButton } from "../components/icon-button";
import { formatTokens } from "../components/usage-meter";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import { useDeleteFold, useUpdateFold } from "../data/p3-hooks";
import { useP3T } from "../i18n/p3-messages";
import { INPUT_SURFACE } from "../components/text-field";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

export interface FoldBlockProps {
  lineId: string;
  fold: Fold;
  /** The "#n" of its first and last chat messages; null when they are not loaded. */
  range: { from: number; to: number } | null;
  /** The original messages, shown when expanded. */
  children?: ReactNode;
  /** Shown open while true (F8 S3: a search jumped into it); it closes again when this ends, unless opened by hand. */
  forceOpen?: boolean;
}

/** 改摘要 (B10 phase B, `PATCH /folds/{fid}`): the user's summary; Esc gives up. */
function SummaryEditor({ lineId, fold, onDone }: { lineId: string; fold: Fold; onDone: () => void }) {
  const t = useP3T();
  const { hostErrorText } = useTangent();
  const update = useUpdateFold(lineId);
  const fieldId = useId();
  const [text, setText] = useState(fold.summary);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    if (!text.trim() || update.isPending) return;
    setError(null);
    update.mutateAsync({ foldId: fold.id, summary: text.trim() }).then(onDone, (failure: unknown) => setError(t("fold.editFailed", { reason: describeError(failure, t, hostErrorText) })));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onDone();
  };
  return (
    <div className="flex flex-col gap-1.5 pl-6">
      <label htmlFor={fieldId} className="text-tg-xs text-tg-muted">
        {t("fold.editField")}
      </label>
      <textarea
        id={fieldId}
        autoFocus
        rows={3}
        maxLength={DEFAULT_FOLD_LIMITS.summaryMaxRunes}
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className={cx(INPUT_SURFACE, "resize-y px-2 py-1.5 font-tg-serif text-tg-sm")}
      />
      <span className="flex gap-1.5">
        <Button size="sm" variant="primary" loading={update.isPending} aria-disabled={!text.trim() || undefined} onClick={save}>
          {t("fold.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("fold.cancel")}
        </Button>
      </span>
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Status({ fold }: { fold: Fold }) {
  const t = useP3T();
  if (fold.status === "drafting") return <Working className="text-tg-xs">{t("fold.drafting")}</Working>;
  if (fold.status === "failed") return <span className="text-tg-xs text-tg-warning">{t("fold.failed")}</span>;
  return <span className="text-tg-xs text-tg-muted">{t("fold.tokens", { summary: formatTokens(fold.tokensSummary), original: formatTokens(fold.tokensOriginal) })}</span>;
}

/**
 * A folded run of messages (D4; components.md `FoldBlock`: r, p 10/12, gap
 * 10; collapsed / the original shown): the range, what AI gets instead and
 * the summary; the original messages stay and show on demand. 取消折疊
 * sends them in full again.
 */
export default function FoldBlock({ lineId, fold, range, children, forceOpen = false }: FoldBlockProps) {
  const t = useP3T();
  const { hostErrorText } = useTangent();
  const readOnly = useReadOnly();
  const remove = useDeleteFold(lineId);
  const [opened, setOpen] = useState(false);
  const open = opened || forceOpen;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originalId = useId();
  const title = range ? t("fold.title", range) : t("fold.titleUnnumbered", { count: fold.messageCount });
  const unfold = () => {
    setError(null);
    remove.mutateAsync({ foldId: fold.id }).catch((failure: unknown) => setError(t("fold.unfoldFailed", { reason: describeError(failure, t, hostErrorText) })));
  };
  return (
    <section aria-label={title} data-tg-fold={fold.id} data-fold-status={fold.status} className="flex flex-col gap-2.5 rounded-tg border border-tg-border-strong bg-tg-surface px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={originalId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-tg-sm text-left text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
        >
          <FoldVertical aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tg-muted" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-tg-sm font-medium">{title}</span>
            <Status fold={fold} />
          </span>
          <span className="flex shrink-0 items-center gap-1 text-tg-xs text-tg-primary-text">
            {open ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
            {open ? t("fold.collapse") : t("fold.expand")}
          </span>
        </button>
        {!readOnly && !editing && <IconButton label={t("fold.edit")} icon={<Pencil />} size="sm" onClick={() => setEditing(true)} />}
        {!readOnly && <IconButton label={t("fold.unfold")} icon={<UnfoldVertical />} size="sm" disabled={remove.isPending} onClick={unfold} />}
      </div>
      {editing && <SummaryEditor lineId={lineId} fold={fold} onDone={() => setEditing(false)} />}
      {!editing && fold.status === "active" && fold.summary && <p className="m-0 pl-6 font-tg-serif text-tg-sm break-words whitespace-pre-wrap text-tg-foreground">{t("fold.summary", { text: fold.summary })}</p>}
      {error && (
        <p role="alert" className="m-0 pl-6 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
      <div id={originalId} role="region" aria-label={t("fold.original")} hidden={!open} className="ml-6 border-l-2 border-tg-border-strong pl-3">
        {open && children}
      </div>
    </section>
  );
}

export { FoldBlock };
