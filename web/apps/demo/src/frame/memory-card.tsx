import { MEMORY_IMPORTANCE, MEMORY_KINDS, type Memory, type MemoryKind } from "@tangent/client";
import { Button, describeError, MEMORY_KIND_KEYS, TextArea, useMemoryT, useReadOnly, useSupersedeMemory, useTangent, useUpdateMemory } from "@tangent/react";
import { useState } from "react";
import { useLibraryT } from "./memory-messages";

const IMPORTANCES = Array.from({ length: MEMORY_IMPORTANCE.max - MEMORY_IMPORTANCE.min + 1 }, (_, index) => MEMORY_IMPORTANCE.min + index);
const SELECT = "h-7 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1.5 text-tg-xs text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11";

export interface MemoryCardProps {
  memory: Memory;
  /** What it replaced, newest first. */
  history: readonly Memory[];
  onGoToSource: (lineId: string) => void;
}

/** The "YYYY-MM-DD" of an ISO time (the date input's value). */
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** One memory (D1 記憶庫): kind, importance, expiry, text, source and what it replaced; a writer recategorizes, re-weighs, sets the expiry or replaces it. */
export function MemoryCard({ memory, history, onGoToSource }: MemoryCardProps) {
  const t = useLibraryT();
  const m = useMemoryT();
  const { hostErrorText } = useTangent();
  const readOnly = useReadOnly();
  const update = useUpdateMemory();
  const supersede = useSupersedeMemory();
  const [replacing, setReplacing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const failed = (failure: unknown) => setError(t("library.failed", { reason: describeError(failure, t, hostErrorText) }));
  const change = (input: { kind?: MemoryKind; importance?: number; validUntil?: string | null }) => {
    setError(null);
    update.mutateAsync({ memoryId: memory.id, input }).catch(failed);
  };
  const replace = () => {
    if (!text.trim() || supersede.isPending) return;
    setError(null);
    supersede.mutateAsync({ memoryId: memory.id, input: { text: text.trim() } }).then(() => {
      setReplacing(false);
      setText("");
    }, failed);
  };
  return (
    <article
      aria-label={memory.text}
      tabIndex={-1}
      className="flex flex-col gap-1.5 rounded-tg border border-tg-border bg-tg-surface-raised px-3 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
    >
      <span className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-tg-subtle">
        <span className="inline-flex h-5 items-center rounded-tg-sm bg-tg-accent px-1.5 text-tg-foreground">{m(MEMORY_KIND_KEYS[memory.kind])}</span>
        <span>{m("memory.importance", { value: memory.importance })}</span>
        {memory.aiDrafted && <span>{t("library.aiDrafted")}</span>}
        <span className="flex-1" />
        <span>{memory.validUntil ? t("library.expires", { date: day(memory.validUntil) }) : t("library.noExpiry")}</span>
      </span>
      <span className="text-tg-sm break-words text-tg-foreground">{memory.text}</span>
      {memory.source.label &&
        (memory.source.lineId ? (
          <button type="button" onClick={() => onGoToSource(memory.source.lineId)} className="self-start text-left text-tg-xs text-tg-primary-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
            {m("memory.source", { label: memory.source.label })}
          </button>
        ) : (
          <span className="text-tg-xs text-tg-muted">{m("memory.source", { label: memory.source.label })}</span>
        ))}
      {history.map((old) => (
        <span key={old.id} className="text-tg-xs text-tg-subtle">
          <s>{old.text}</s> {t("library.replacedBy")}（{day(old.updatedAt)}）
        </span>
      ))}
      {!readOnly && (
        <span className="flex flex-wrap items-center gap-2 pt-1 text-tg-xs text-tg-muted">
          <label className="flex items-center gap-1">
            {t("library.kind")}
            <select value={memory.kind} onChange={(event) => change({ kind: event.currentTarget.value as MemoryKind })} className={SELECT}>
              {MEMORY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {m(MEMORY_KIND_KEYS[kind])}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            {t("library.importance")}
            <select value={memory.importance} onChange={(event) => change({ importance: Number(event.currentTarget.value) })} className={SELECT}>
              {IMPORTANCES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            {t("library.validUntil")}
            <input type="date" value={day(memory.validUntil)} onChange={(event) => change({ validUntil: event.currentTarget.value ? `${event.currentTarget.value}T00:00:00Z` : null })} className={SELECT} />
          </label>
          {!replacing && (
            <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
              {t("library.supersede")}
            </Button>
          )}
        </span>
      )}
      {replacing && (
        <span className="flex flex-col gap-1.5">
          <TextArea label={t("library.newText")} rows={2} value={text} onChange={(event) => setText(event.currentTarget.value)} />
          <span className="flex gap-1.5">
            <Button size="sm" variant="primary" loading={supersede.isPending} aria-disabled={!text.trim() || undefined} onClick={replace}>
              {t("library.replace")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
              {t("library.cancel")}
            </Button>
          </span>
        </span>
      )}
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
