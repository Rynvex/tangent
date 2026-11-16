import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cx } from "../lib/cx";
import { useTangentPortalContainer } from "../root/tangent-root";

export const POPUP_MOTION =
  "origin-(--transform-origin) transition-[opacity,scale] duration-(--tg-duration-fast) ease-tg-out " +
  "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0";

/** Tooltips keep full opacity throughout their motion so contrast stays valid if measured mid-transition. */
export const TOOLTIP_MOTION =
  "origin-(--transform-origin) transition-transform duration-(--tg-duration-fast) ease-tg-out " +
  "data-starting-style:scale-95 data-ending-style:scale-95";

export interface TooltipProps {
  /** The tooltip text: supplementary only, never the sole carrier of information. */
  content: ReactNode;
  /** One element that accepts props and a ref (a button, an IconButton…). */
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

/**
 * A hover / focus hint (Base UI Tooltip). Not shown on touch devices; an
 * icon-only trigger still needs its own aria-label.
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const container = useTangentPortalContainer();
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal container={container ?? undefined}>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup
            className={cx(
              "flex items-center gap-2 rounded-tg-sm bg-tg-foreground-strong px-2 py-1 text-tg-xs text-tg-background shadow-tg-overlay",
              TOOLTIP_MOTION,
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
