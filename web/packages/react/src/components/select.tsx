import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";
import { INPUT_SURFACE } from "./text-field";
import { POPUP_MOTION } from "./tooltip";

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string> {
  /** Visible label; Base UI wires it to the trigger. */
  label?: ReactNode;
  options: readonly SelectOption<V>[];
  value?: V | null;
  defaultValue?: V | null;
  onValueChange?: (value: V) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  className?: string;
}

/** A single-choice select (Base UI Select) with the input edge and a token-styled list. */
export function Select<V extends string>({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  disabled,
  className,
  ...rest
}: SelectProps<V>) {
  const t = useUiT();
  const container = useTangentPortalContainer();
  const items = options.map((option) => ({ value: option.value, label: option.label }));
  return (
    <SelectPrimitive.Root
      items={items}
      {...(value !== undefined ? { value } : {})}
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange?.(next as V);
      }}
      disabled={disabled}
    >
      <div className={cx("flex flex-col gap-1.5", className)}>
        {label && <SelectPrimitive.Label className="text-tg-sm font-medium text-tg-foreground">{label}</SelectPrimitive.Label>}
        <SelectPrimitive.Trigger
          aria-label={rest["aria-label"]}
          className={cx(INPUT_SURFACE, "flex h-(--tg-control-height) min-w-40 items-center justify-between gap-2 px-2.5 text-left data-disabled:opacity-45")}
        >
          <SelectPrimitive.Value className="truncate data-placeholder:text-tg-subtle" placeholder={placeholder ?? t("ui.selectPlaceholder")} />
          <SelectPrimitive.Icon className="flex text-tg-muted">
            <ChevronDown aria-hidden className="size-4" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
      </div>
      <SelectPrimitive.Portal container={container ?? undefined}>
        <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <SelectPrimitive.Popup
            className={cx(
              "min-w-(--anchor-width) rounded-tg border border-tg-border-strong bg-tg-surface-raised p-1 text-tg-sm text-tg-foreground shadow-tg-overlay outline-none",
              POPUP_MOTION,
            )}
          >
            <SelectPrimitive.List className="max-h-(--available-height) overflow-y-auto">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="flex min-h-(--tg-control-height) cursor-default items-center gap-2 rounded-tg-sm px-2.5 outline-none select-none data-disabled:opacity-45 data-highlighted:bg-tg-accent data-highlighted:shadow-[inset_3px_0_0_var(--tg-ring)]"
                >
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="flex text-tg-primary-text">
                    <Check aria-hidden className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
