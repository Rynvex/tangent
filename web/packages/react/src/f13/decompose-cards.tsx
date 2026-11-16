/**
 * The decompose panel's cards (F13 S4 DecomposeCard): pending suggestions
 * have a dashed suggestion edge, applied ones a solid edge on a sunken fill
 * with 「已套用」 and, where the write can be taken back, 復原.
 */
import { Check, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useF13T } from "../i18n/f13-messages";

/** Where one suggestion stands. */
export type ItemState =
  | { status: "pending" }
  | { status: "busy" }
  | { status: "applied"; undo?: () => Promise<unknown>; branchLineId?: string; count?: number; error?: string }
  | { status: "skipped" }
  | { status: "error"; message: string };

export const PENDING: ItemState = { status: "pending" };

/** A small action button of a card (h28, touch 40). */
export function CardButton({ children, onClick, primary = false, disabled = false, icon }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      aria-disabled={disabled || undefined}
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-tg-sm px-2.5 text-tg-xs font-medium transition-colors duration-(--tg-duration-fast) pointer-coarse:h-10",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:shrink-0",
        primary ? "bg-tg-primary text-tg-primary-foreground hover:bg-tg-primary-hover" : "border border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** A text-only action (略過, 復原, 看支線). */
export function LinkButton({ children, onClick, icon }: { children: ReactNode; onClick: () => void; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-tg-sm px-1.5 text-tg-xs font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-10 [&_svg]:size-3.5"
    >
      {icon}
      {children}
    </button>
  );
}

export interface DecomposeCardProps {
  number: number;
  title: string;
  /** Applied: solid edge, sunken fill, the 已套用 badge. */
  applied?: boolean;
  /** Hovering or focusing the card outlines its messages in the transcript (detours). */
  onFocusChange?: (inside: boolean) => void;
  children: ReactNode;
}

export function DecomposeCard({ number, title, applied = false, onFocusChange, children }: DecomposeCardProps) {
  const t = useF13T();
  const id = `tg-decompose-card-${number}`;
  return (
    <section
      aria-labelledby={id}
      onPointerEnter={() => onFocusChange?.(true)}
      onPointerLeave={() => onFocusChange?.(false)}
      onFocus={() => onFocusChange?.(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusChange?.(false);
      }}
      className={cx("flex flex-col gap-2 rounded-tg border p-3", applied ? "border-tg-border bg-tg-surface-sunken" : "border-dashed border-tg-suggestion bg-tg-surface")}
    >
      <header className="flex items-center gap-2">
        <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-tg-full bg-tg-surface-sunken text-tg-xs font-semibold text-tg-foreground">
          {number}
        </span>
        <h3 id={id} className="m-0 min-w-0 flex-1 truncate text-tg-sm font-semibold text-tg-foreground-strong">
          {title}
        </h3>
        {applied && <AppliedBadge label={t("decompose.applied")} />}
      </header>
      {children}
    </section>
  );
}

export function AppliedBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-tg-full bg-tg-primary-soft px-2 py-0.5 text-tg-xs font-medium text-tg-primary-text">
      <Check aria-hidden className="size-3" />
      {label}
    </span>
  );
}

/** The applied / skipped / failed line under an item, with 復原 when it can be taken back. */
export function ItemStatus({ state, appliedText, onUndo, extra }: { state: ItemState; appliedText: string; onUndo?: () => void; extra?: ReactNode }) {
  const t = useF13T();
  if (state.status === "error") {
    return (
      <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-2 py-1.5 text-tg-xs text-tg-foreground">
        {state.message}
      </p>
    );
  }
  if (state.status !== "applied" && state.status !== "skipped") return null;
  return (
    <>
    {state.status === "applied" && state.error && (
      <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-2 py-1.5 text-tg-xs text-tg-foreground">
        {state.error}
      </p>
    )}
    <p className="m-0 flex flex-wrap items-center gap-2 text-tg-xs text-tg-muted">
      <span role="status">{state.status === "skipped" ? t("decompose.skipped") : appliedText}</span>
      {extra}
      {onUndo && (
        <LinkButton onClick={onUndo} icon={<Undo2 aria-hidden />}>
          {t("decompose.undo")}
        </LinkButton>
      )}
    </p>
    </>
  );
}

/** Four skeleton cards while the plan loads. */
export function CardSkeletons() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="h-24 animate-pulse rounded-tg border border-dashed border-tg-border bg-tg-surface-sunken motion-reduce:animate-none" />
      ))}
    </div>
  );
}
