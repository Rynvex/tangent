import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useTangentPortalContainer } from "../root/tangent-root";
import { POPUP_MOTION } from "./tooltip";

/** Base UI's root: `open`, `defaultOpen`, `onOpenChange`, `modal`. */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export interface PopoverContentProps {
  /** Labels the popup (aria-labelledby); render a visible title or pass `aria-label`. */
  title?: ReactNode;
  "aria-label"?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** An element to sit against instead of the trigger (F13: the list row a menu item opened it from). */
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  /** Focus target on open (defaults to the first tabbable element). */
  initialFocus?: PopoverPrimitive.Popup.Props["initialFocus"];
  className?: string;
  children: ReactNode;
}

/** A floating panel anchored to its trigger (ForkPeek, UsageMeter details…). */
export function PopoverContent({ title, side = "bottom", align = "start", anchor, initialFocus, className, children, ...rest }: PopoverContentProps) {
  const container = useTangentPortalContainer();
  return (
    <PopoverPrimitive.Portal container={container ?? undefined}>
      <PopoverPrimitive.Positioner side={side} align={align} sideOffset={6} collisionPadding={8} className="z-50" {...(anchor ? { anchor } : {})}>
        <PopoverPrimitive.Popup
          {...(initialFocus ? { initialFocus } : {})}
          aria-label={rest["aria-label"]}
          className={cx(
            "flex max-w-[min(35rem,calc(100vw-1rem))] flex-col gap-1.5 rounded-tg border border-tg-border-strong bg-tg-surface-raised px-3 py-2.5 text-tg-sm text-tg-foreground shadow-tg-overlay outline-none",
            POPUP_MOTION,
            className,
          )}
        >
          {title && <PopoverPrimitive.Title className="m-0 text-tg-xs font-medium text-tg-muted">{title}</PopoverPrimitive.Title>}
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}
