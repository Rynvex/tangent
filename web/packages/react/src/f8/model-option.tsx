import { useId, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../lib/cx";

/** A provider / model the dialogs offer; `disabled` with its reason when the server does not allow it. */
export interface ModelChoice {
  provider: string;
  model: string;
  disabled?: boolean;
  /** Small text after the name: 「#8 用的」, 「不在允許的清單」. */
  note?: string;
}

export const modelKey = (choice: Pick<ModelChoice, "provider" | "model">) => `${choice.provider}\u0000${choice.model}`;

interface ModelOptionsProps {
  /** The group's name (a visible label's id). */
  labelledBy: string;
  choices: readonly ModelChoice[];
  /** Selected keys (`modelKey`). */
  selected: ReadonlySet<string>;
  /** `radio`: one model (分岔重答); `checkbox`: several (跨模型比較). */
  mode: "radio" | "checkbox";
  onToggle: (choice: ModelChoice) => void;
  /** Under each card (the branch's purpose a cross-model diverge would write). */
  detail?: (choice: ModelChoice) => ReactNode;
}

/**
 * Model cards (S7, S8; components.md `ModelOption`): h40 (touch 48), the
 * model id in the monospace face and its provider; single choice or
 * check boxes; a model the server does not allow is listed at 45% with its
 * reason. Arrow keys move between cards; Space or Enter picks.
 */
export function ModelOptions({ labelledBy, choices, selected, mode, onToggle, detail }: ModelOptionsProps) {
  const name = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const inputs = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input:not(:disabled)")];
    const at = inputs.indexOf(document.activeElement as HTMLInputElement);
    if (at < 0) return;
    event.preventDefault();
    inputs[(at + step + inputs.length) % inputs.length]?.focus();
  };
  return (
    <div role={mode === "radio" ? "radiogroup" : "group"} aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="flex flex-col gap-1.5">
      {choices.map((choice) => {
        const key = modelKey(choice);
        const checked = selected.has(key);
        return (
          <label
            key={key}
            className={cx(
              "flex min-h-10 cursor-pointer items-center gap-2.5 rounded-tg-sm border px-3 py-1.5 pointer-coarse:min-h-12",
              checked ? "border-tg-primary bg-tg-primary-soft" : "border-tg-border-strong hover:border-tg-foreground",
              choice.disabled && "cursor-not-allowed opacity-45 hover:border-tg-border-strong",
            )}
          >
            <input
              type={mode}
              name={mode === "radio" ? name : undefined}
              checked={checked}
              disabled={choice.disabled}
              onChange={() => onToggle(choice)}
              className="size-4 shrink-0 accent-(--tg-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="truncate font-tg-mono text-tg-sm text-tg-foreground">{choice.model}</span>
                {choice.provider && <span className="text-tg-xs text-tg-muted">{choice.provider}</span>}
                {choice.note && <span className="text-tg-xs text-tg-muted">・{choice.note}</span>}
              </span>
              {detail && <span className="truncate text-tg-xs text-tg-muted">{detail(choice)}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
