/**
 * The Settings page's building blocks (G2): a card with a heading, a row
 * (name, short description, its control on the right) and the on / off
 * switch. Rows carry `data-setting`, so the search can scroll to one and
 * light it up.
 */
import { Button } from "@tangent/react";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { cx } from "./cx";

/** The row the search just jumped to (lit for a moment). */
export const HighlightContext = createContext<string | null>(null);

export interface SettingsGroupProps {
  title: string;
  /** A note under the heading. */
  note?: ReactNode;
  children: ReactNode;
}

/** A card: its heading, then rows divided by hairlines inside one rounded border. */
export function SettingsGroup({ title, note, children }: SettingsGroupProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="m-0 px-1 text-tg-xs font-semibold tracking-wide text-tg-muted uppercase">
        {title}
      </h3>
      {note && <p className="m-0 px-1 text-tg-xs text-tg-subtle">{note}</p>}
      <div className="flex flex-col divide-y divide-tg-border overflow-hidden rounded-tg border border-tg-border bg-tg-surface">{children}</div>
    </section>
  );
}

export interface SettingRowProps {
  /** The entry's id (settings-index.ts). */
  id: string;
  title: string;
  description?: ReactNode;
  /**
   * The control, given the ids of the row's name and description so it can
   * name itself (`aria-labelledby` / `aria-describedby`).
   */
  children: ReactNode | ((ids: { labelId: string; descriptionId: string | undefined }) => ReactNode);
  /** Something under the row's text and control (a status line, a hint). */
  below?: ReactNode;
}

/** One setting: its name and description on the left, its control on the right (under them on a narrow screen). */
export function SettingRow({ id, title, description, children, below }: SettingRowProps) {
  const highlighted = useContext(HighlightContext) === id;
  const labelId = useId();
  const descId = useId();
  const descriptionId = description ? descId : undefined;
  return (
    <div
      data-setting={id}
      data-highlighted={highlighted || undefined}
      className={cx("flex flex-col gap-2 px-4 py-3 transition-colors duration-(--tg-duration-normal)", highlighted && "bg-tg-highlight")}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex min-w-48 flex-1 flex-col gap-0.5">
          <span id={labelId} className="text-tg-sm font-medium text-tg-foreground-strong">
            {title}
          </span>
          {description && (
            <span id={descId} className="text-tg-xs text-tg-muted">
              {description}
            </span>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{typeof children === "function" ? children({ labelId, descriptionId }) : children}</div>
      </div>
      {below}
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The id of the text that names it. */
  labelId: string;
  descriptionId?: string | undefined;
  disabled?: boolean;
}

/** An on / off switch (`role="switch"`, named by its row): Space or Enter toggles. */
export function Switch({ checked, onCheckedChange, labelId, descriptionId, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={descriptionId}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        "relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-tg-full border transition-colors duration-(--tg-duration-fast)",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring disabled:cursor-not-allowed disabled:opacity-45",
        // A hit area of --tg-hit-target around the 22px track (44px on touch).
        "before:absolute before:top-1/2 before:left-1/2 before:h-(--tg-hit-target) before:w-full before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        checked ? "border-tg-primary bg-tg-primary" : "border-tg-border-input bg-tg-surface-sunken",
      )}
    >
      <span
        aria-hidden
        className={cx(
          "inline-block size-4 rounded-tg-full shadow-tg transition-transform duration-(--tg-duration-fast) ease-tg-out",
          checked ? "translate-x-5 bg-tg-primary-foreground" : "translate-x-0.5 bg-tg-muted",
        )}
      />
    </button>
  );
}

/** A small line under a row's control: what happened, or what stands in the way. */
export function RowNote({ children, tone = "muted", role }: { children: ReactNode; tone?: "muted" | "warning" | "destructive"; role?: "status" | "alert" }) {
  const colour = tone === "warning" ? "text-tg-warning" : tone === "destructive" ? "text-tg-destructive" : "text-tg-muted";
  return (
    <p role={role} className={cx("m-0 text-tg-xs", colour)}>
      {children}
    </p>
  );
}

export interface ConfirmButtonProps {
  label: string;
  /** The second question, said next to the two answers. */
  question: string;
  confirm: string;
  cancel: string;
  onConfirm: () => void;
  size?: "md" | "sm";
}

/** A button that asks once more in place before it acts (Esc or 取消 backs out). */
export function ConfirmButton({ label, question, confirm, cancel, onConfirm, size = "md" }: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Button size={size} onClick={() => setAsking(true)}>
        {label}
      </Button>
    );
  return (
    <span
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Esc backs out of the question, not out of the whole dialog.
        event.stopPropagation();
        setAsking(false);
      }}
    >
      <span className="text-tg-xs text-tg-destructive">{question}</span>
      <Button size="sm" autoFocus onClick={() => setAsking(false)}>
        {cancel}
      </Button>
      <Button
        size="sm"
        variant="destructive"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirm}
      </Button>
    </span>
  );
}
