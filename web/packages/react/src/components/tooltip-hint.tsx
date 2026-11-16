import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/cx";
import { useTangentPortalContainer } from "../root/tangent-root";
import { TOOLTIP_MOTION } from "./tooltip";

/** How long a hint waits before opening (pointer); focus from the keyboard opens it at once. */
const HINT_DELAY_MS = 500;
/** Moving straight from one hinted control to the next opens its hint at once (Base UI's provider did this before F9). */
const HINT_GROUP_MS = 400;
let lastClosedAt = 0;

/** Keyboard focus (`:focus-visible`); an engine without the selector counts every focus. */
function focusVisible(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** False when the trigger is detached or hidden behind an open modal (`aria-hidden` / `inert`). */
function isInteractive(element: HTMLElement): boolean {
  return element.isConnected && !element.closest("[inert], [aria-hidden='true']");
}

/** False on touch-only viewports so Chromium's sticky `:hover` after a tap does not trigger a hint. */
function canHover(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia("(hover: hover)").matches;
}

export interface TooltipHintProps {
  /** The control the hint describes (an IconButton). */
  anchor: RefObject<HTMLElement | null>;
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}

/**
 * An IconButton's hint (F9: loaded the first time a hinted control is
 * pointed at or focused, so Base UI's tooltip and its positioning stay out
 * of the main bundle). It follows the control's own pointer and focus
 * events; touch never opens it; Esc closes it (anywhere on the page).
 */
export default function TooltipHint({ anchor, content, side = "top" }: TooltipHintProps) {
  const container = useTangentPortalContainer();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (delay: number) => {
      clearTimeout(timer);
      if (!isInteractive(element)) return;
      timer = setTimeout(() => {
        if (isInteractive(element)) setOpen(true);
      }, Date.now() - lastClosedAt < HINT_GROUP_MS ? 0 : delay);
    };
    const hide = () => {
      clearTimeout(timer);
      setOpen((was) => {
        if (was) lastClosedAt = Date.now();
        return false;
      });
    };
    const onEnter = (event: PointerEvent) => event.pointerType !== "touch" && show(HINT_DELAY_MS);
    const onFocus = () => isInteractive(element) && focusVisible(element) && show(0);
    element.addEventListener("pointerenter", onEnter);
    element.addEventListener("pointerleave", hide);
    element.addEventListener("pointerdown", hide);
    element.addEventListener("focus", onFocus);
    element.addEventListener("blur", hide);
    // Mounted by the event that asked for it: pick up where that event left the control.
    if (isInteractive(element)) {
      if (element === document.activeElement && focusVisible(element)) show(0);
      else if (canHover() && element.matches(":hover")) show(HINT_DELAY_MS);
    }
    return () => {
      clearTimeout(timer);
      element.removeEventListener("pointerenter", onEnter);
      element.removeEventListener("pointerleave", hide);
      element.removeEventListener("pointerdown", hide);
      element.removeEventListener("focus", onFocus);
      element.removeEventListener("blur", hide);
    };
  }, [anchor]);
  // Esc closes an open hint wherever focus is (WCAG 1.4.13: a hover hint must be dismissable without moving the pointer).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      lastClosedAt = Date.now();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={(next) => !next && setOpen(false)}>
      <TooltipPrimitive.Portal container={container ?? undefined}>
        <TooltipPrimitive.Positioner anchor={anchor} side={side} sideOffset={6} className="z-50">
          <TooltipPrimitive.Popup className={cx("flex items-center gap-2 rounded-tg-sm bg-tg-foreground-strong px-2 py-1 text-tg-xs text-tg-background shadow-tg-overlay", TOOLTIP_MOTION)}>{content}</TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
