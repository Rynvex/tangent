import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";

/** Base UI's root: `value`, `defaultValue`, `onValueChange`. Arrow keys move between tabs. */
export const Tabs = TabsPrimitive.Root;

export interface TabsListProps {
  "aria-label"?: string;
  className?: string;
  children: ReactNode;
}

export function TabsList({ className, children, ...rest }: TabsListProps) {
  return (
    <TabsPrimitive.List aria-label={rest["aria-label"]} className={cx("flex items-stretch gap-1", className)}>
      {children}
    </TabsPrimitive.List>
  );
}

export interface TabProps {
  value: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/** A tab with the selected 2px rule of components.md (選取：分頁用 2px 底線). */
export function Tab({ value, disabled, className, children }: TabProps) {
  return (
    <TabsPrimitive.Tab
      value={value}
      disabled={disabled}
      className={cx(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-2.5 text-tg-sm font-medium whitespace-nowrap text-tg-muted",
        "transition-colors duration-(--tg-duration-fast) hover:text-tg-foreground",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tg-ring",
        "data-active:border-tg-foreground-strong data-active:text-tg-foreground-strong data-disabled:opacity-45",
        className,
      )}
    >
      {children}
    </TabsPrimitive.Tab>
  );
}

export interface TabsPanelProps {
  value: string;
  /** Keep the panel (and its state) in the page while another tab shows (F14's phone tabs). */
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
}

export function TabsPanel({ value, keepMounted, className, children }: TabsPanelProps) {
  return (
    <TabsPrimitive.Panel value={value} keepMounted={keepMounted} className={cx("min-h-0 flex-1 outline-none", className)}>
      {children}
    </TabsPrimitive.Panel>
  );
}
