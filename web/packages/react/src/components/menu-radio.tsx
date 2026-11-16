/**
 * A choice between a few values inside a menu (`menuitemradio`): the group's
 * label, then one row per value with a dot on the chosen one. Apart from
 * `menu.tsx`, so only the menus that offer a choice carry it.
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export interface MenuRadioGroupProps<T extends string> {
  /** What is being chosen (the group's visible label). */
  label: ReactNode;
  /** A smaller line under the label (where the choice is kept, …). */
  note?: ReactNode;
  value: T;
  onValueChange: (value: T) => void;
  children: ReactNode;
}

export function MenuRadioGroup<T extends string>({ label, note, value, onValueChange, children }: MenuRadioGroupProps<T>) {
  return (
    <MenuPrimitive.Group>
      <MenuPrimitive.GroupLabel className="flex flex-col px-2.5 pt-2 pb-1 text-tg-xs leading-tight font-medium text-tg-subtle">
        <span>{label}</span>
        {note && <span className="font-normal text-tg-muted">{note}</span>}
      </MenuPrimitive.GroupLabel>
      <MenuPrimitive.RadioGroup value={value} onValueChange={(next) => onValueChange(next as T)}>
        {children}
      </MenuPrimitive.RadioGroup>
    </MenuPrimitive.Group>
  );
}

export interface MenuRadioItemProps {
  value: string;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** One value of the group; choosing it closes the menu. */
export function MenuRadioItem({ value, icon, className, children }: MenuRadioItemProps) {
  return (
    <MenuPrimitive.RadioItem
      value={value}
      closeOnClick
      className={cx(
        "flex min-h-(--tg-control-height) cursor-default items-center gap-2 rounded-tg-sm px-2.5 text-tg-foreground outline-none select-none",
        "data-highlighted:bg-tg-accent data-highlighted:shadow-[inset_3px_0_0_var(--tg-ring)] data-disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span aria-hidden className="flex size-4 items-center justify-center">
        <MenuPrimitive.RadioItemIndicator className="size-2 rounded-tg-full bg-tg-primary" />
      </span>
    </MenuPrimitive.RadioItem>
  );
}
