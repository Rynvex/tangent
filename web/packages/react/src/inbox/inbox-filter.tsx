import type { Suggestion } from "@tangent/client";
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { describeError } from "../conversation/error-text";
import { useDismissAllSuggestions } from "../data/p1-hooks";
import { useF12T } from "../i18n/f12-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

export type InboxFilter = "all" | "seeds" | "suggestions";

/** Decision #5: 「已忽略 n 條 AI 建議」 stays this long, then goes. */
export const DISMISSED_ROW_MS = 5000;
const FILTER_KEY = "tangent:inbox-filter:v1";

/** S5: the filter for this visit (sessionStorage), reset to 全部 for another conversation. */
export function readInboxFilter(rootLineId: string): InboxFilter {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(FILTER_KEY) ?? "null");
    const saved = raw as { root?: unknown; filter?: unknown } | null;
    if (saved?.root === rootLineId && (saved.filter === "seeds" || saved.filter === "suggestions")) return saved.filter;
  } catch {
    // Nothing kept, or storage blocked.
  }
  return "all";
}

export function saveInboxFilter(rootLineId: string, filter: InboxFilter): void {
  try {
    window.sessionStorage.setItem(FILTER_KEY, JSON.stringify({ root: rootLineId, filter }));
  } catch {
    // Storage blocked: the choice holds while the panel stays open.
  }
}

export interface InboxFilterChipsProps {
  value: InboxFilter;
  onValueChange: (value: InboxFilter) => void;
  /** Open counts; a chip with 0 still shows "(0)" and can be chosen (its empty state). */
  seeds: number | null;
  suggestions: number | null;
}

/**
 * S5 InboxFilterChips (h28, touch 44): one choice — 全部｜停車種子 (n)｜AI 建議
 * (n), a chip only for a feature that is on. Arrow keys move between them
 * (radio semantics); the row scrolls sideways on narrow screens.
 */
export function InboxFilterChips({ value, onValueChange, seeds, suggestions }: InboxFilterChipsProps) {
  const t = useF12T();
  const group = useRef<HTMLDivElement>(null);
  const chips: { id: InboxFilter; label: string }[] = [
    { id: "all", label: t("inbox.filterAll") },
    ...(seeds !== null ? [{ id: "seeds" as const, label: t("inbox.filterSeeds", { n: seeds }) }] : []),
    ...(suggestions !== null ? [{ id: "suggestions" as const, label: t("inbox.filterSuggestions", { n: suggestions }) }] : []),
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = Math.max(0, chips.findIndex((chip) => chip.id === value));
    const next = chips[(at + step + chips.length) % chips.length]!;
    onValueChange(next.id);
    group.current?.querySelector<HTMLElement>(`[data-value="${next.id}"]`)?.focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-label={t("inbox.filterLabel")} onKeyDown={onKeyDown} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5">
      {chips.map((chip) => {
        const checked = chip.id === value;
        const empty = (chip.id === "seeds" && seeds === 0) || (chip.id === "suggestions" && suggestions === 0);
        return (
          <button
            key={chip.id}
            type="button"
            role="radio"
            data-value={chip.id}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onValueChange(chip.id)}
            className={cx(
              "inline-flex h-7 shrink-0 items-center rounded-tg-full border px-3 text-tg-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11",
              checked ? "border-tg-primary bg-tg-primary-soft font-medium text-tg-primary-text" : cx("border-tg-border-input bg-tg-surface hover:bg-tg-accent", empty ? "text-tg-muted" : "text-tg-foreground"),
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * S5 DismissAllSuggestions: 忽略全部 (no confirmation and no undo, decision
 * #5), 忽略中… while it runs, then 「已忽略 n 條 AI 建議」 in place of the list
 * for 5 seconds. A failure keeps the suggestions and says why.
 */
export function useDismissAll(rootLineId: string) {
  const t = useF12T();
  const { hostErrorText } = useTangent();
  const dismissAll = useDismissAllSuggestions(rootLineId);
  const [done, setDone] = useState<{ ids: ReadonlySet<string>; count: number; showing: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!done?.showing) return undefined;
    const timer = setTimeout(() => setDone((current) => (current ? { ...current, showing: false } : current)), DISMISSED_ROW_MS);
    return () => clearTimeout(timer);
  }, [done?.showing]);
  const run = () => {
    if (dismissAll.isPending) return;
    setError(null);
    dismissAll.mutateAsync().then(
      (result) => setDone({ ids: new Set(result.suggestions.map((item) => item.id)), count: result.suggestions.length, showing: true }),
      (failure: unknown) => setError(t("inbox.dismissFailed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  return {
    run,
    pending: dismissAll.isPending,
    error,
    /** The row 「已忽略 n 條」 while it shows. */
    // Nothing dismissed (another tab got there first): no 「已忽略 0 條」.
    dismissedCount: done?.showing && done.count > 0 ? done.count : null,
    /** Suggestions this press dismissed: not listed again as decided cards. */
    hides: (suggestion: Suggestion) => done?.ids.has(suggestion.id) === true,
  };
}

export function DismissAllButton({ count, pending, onClick }: { count: number; pending: boolean; onClick: () => void }) {
  const t = useF12T();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-disabled={pending || undefined}
      aria-label={pending ? t("inbox.dismissing") : t("inbox.dismissAllLabel", { n: count })}
      className="inline-flex h-6.5 shrink-0 items-center gap-1 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.25 text-tg-xs text-tg-foreground hover:bg-tg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring disabled:opacity-45 pointer-coarse:h-11"
    >
      {!pending && <X aria-hidden className="size-3" />}
      {pending ? t("inbox.dismissing") : t("inbox.dismissAll")}
    </button>
  );
}

export function DismissedRow({ count }: { count: number }) {
  const t = useF12T();
  return (
    <p role="status" className="m-0 inline-flex items-center gap-1.5 self-start rounded-tg-sm bg-tg-surface-sunken px-2.5 py-1.5 text-tg-xs text-tg-muted">
      <Check aria-hidden className="size-3" />
      {t("inbox.dismissedN", { n: count })}
    </p>
  );
}
