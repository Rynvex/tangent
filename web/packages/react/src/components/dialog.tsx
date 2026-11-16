import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";
import { IconButton } from "./icon-button";

/** Base UI's root: `open`, `defaultOpen`, `onOpenChange`, `modal`. */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** Widths from components.md (dialog forms 560, review 760, settings 600; F13's import 640; F14's two-column import 880; a page of its own, such as a library, 1152). */
export type DialogWidth = "sm" | "md" | "lg" | "wide" | "xl" | "split" | "page";

const WIDTHS: Record<DialogWidth, string> = {
  sm: "sm:max-w-[25rem]",
  md: "sm:max-w-[35rem]",
  lg: "sm:max-w-[37.5rem]",
  wide: "sm:max-w-[40rem]",
  xl: "sm:max-w-[47.5rem]",
  split: "sm:max-w-[55rem]",
  page: "sm:max-w-[72rem]",
};

export interface DialogContentProps {
  title: ReactNode;
  /** Shown under the title and wired to aria-describedby. */
  description?: ReactNode;
  /** Buttons at the bottom, right-aligned. */
  footer?: ReactNode;
  width?: DialogWidth;
  /** Hides the corner close button (the dialog still closes on Esc). */
  hideClose?: boolean;
  /** Body padding; turn off for lists that run to the edges (command palette). */
  padded?: boolean;
  className?: string;
  children?: ReactNode;
  /** Focus target on open; defaults to the first tabbable element. */
  initialFocus?: DialogPrimitive.Popup.Props["initialFocus"];
  /** Focus target on close; defaults to the trigger (or what had focus). Set it when the action removes the trigger. */
  finalFocus?: DialogPrimitive.Popup.Props["finalFocus"];
}

/**
 * The popup of a dialog: scrim, title, optional description, scrolling body
 * and footer. Under 640px wide it fills the screen (handoff width rules).
 */
export function DialogContent({
  title,
  description,
  footer,
  width = "md",
  hideClose = false,
  padded = true,
  className,
  children,
  initialFocus,
  finalFocus,
}: DialogContentProps) {
  const t = useUiT();
  const container = useTangentPortalContainer();
  return (
    <DialogPrimitive.Portal container={container ?? undefined}>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim transition-opacity duration-(--tg-duration-normal) data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-center justify-center sm:p-4">
        {/* Every dialog here is modal (Base UI's default): say so to assistive tech too (R11). */}
        <DialogPrimitive.Popup
          aria-modal="true"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          className={cx(
            "flex h-full max-h-full w-full flex-col overflow-hidden bg-tg-surface-raised text-tg-foreground shadow-tg-overlay outline-none",
            "sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:rounded-tg-lg",
            "transition-[opacity,scale] duration-(--tg-duration-normal) ease-tg-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            WIDTHS[width],
            className,
          )}
        >
          <header className="flex items-start gap-3 border-b border-tg-border px-5 pt-4.5 pb-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogPrimitive.Title className="m-0 text-tg-lg font-semibold text-tg-foreground-strong">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="m-0 text-tg-xs text-tg-muted">{description}</DialogPrimitive.Description>}
            </div>
            {!hideClose && <DialogPrimitive.Close render={<IconButton label={t("ui.close")} icon={<X />} size="sm" tooltip={false} />} />}
          </header>
          <div className={cx("min-h-0 flex-1 overflow-auto", padded && "flex flex-col gap-4 px-5 py-4")}>{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-tg-border px-5 py-3">{footer}</footer>}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}
