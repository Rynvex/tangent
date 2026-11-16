import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useTangentPortalContainer } from "../root/tangent-root";
import { POPUP_MOTION } from "./tooltip";

/** Base UI's root: `open`, `defaultOpen`, `onOpenChange`. */
export const Menu = MenuPrimitive.Root;
export const MenuTrigger = MenuPrimitive.Trigger;

export interface MenuContentProps {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  children: ReactNode;
  /** Positions the popup against this element instead of the trigger (a menu opened without one: F8's lazy 「⋯」). */
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  /** Where focus goes when the menu closes; defaults to the trigger. */
  finalFocus?: MenuPrimitive.Popup.Props["finalFocus"];
}

/** The menu's popup; arrow keys move between items, typing jumps, Esc closes. */
export function MenuContent({ side = "bottom", align = "start", className, children, anchor, finalFocus }: MenuContentProps) {
  const container = useTangentPortalContainer();
  return (
    <MenuPrimitive.Portal container={container ?? undefined}>
      <MenuPrimitive.Positioner side={side} align={align} sideOffset={4} collisionPadding={8} className="z-50" {...(anchor ? { anchor } : {})}>
        <MenuPrimitive.Popup
          {...(finalFocus !== undefined ? { finalFocus } : {})}
          className={cx(
            "flex min-w-44 flex-col rounded-tg border border-tg-border-strong bg-tg-surface-raised p-1 text-tg-sm text-tg-foreground shadow-tg-overlay outline-none",
            POPUP_MOTION,
            className,
          )}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export interface MenuItemProps {
  onSelect?: () => void;
  icon?: ReactNode;
  /** Shown at the end of the row, e.g. `<ShortcutKeys>`. */
  shortcut?: ReactNode;
  /** Destructive actions use the error colour (components.md). */
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function MenuItem({ onSelect, icon, shortcut, destructive = false, disabled = false, className, children }: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      disabled={disabled}
      onClick={() => onSelect?.()}
      className={cx(
        "flex min-h-(--tg-control-height) cursor-default items-center gap-2 rounded-tg-sm px-2.5 outline-none select-none",
        "data-highlighted:bg-tg-accent data-highlighted:shadow-[inset_3px_0_0_var(--tg-ring)] data-disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
        destructive ? "text-tg-destructive" : "text-tg-foreground",
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut}
    </MenuPrimitive.Item>
  );
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="mx-1 my-1 h-px bg-tg-border" />;
}

export function MenuGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <MenuPrimitive.Group>
      <MenuPrimitive.GroupLabel className="px-2.5 pt-2 pb-1 text-tg-xs font-medium text-tg-subtle">{label}</MenuPrimitive.GroupLabel>
      {children}
    </MenuPrimitive.Group>
  );
}
