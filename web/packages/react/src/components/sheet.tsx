import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { useTangentPortalContainer } from "../root/tangent-root";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet's accessible name. */
  label: string;
  className?: string;
  children: ReactNode;
}

/**
 * A phone's bottom sheet (F13 S5's 資料夾與標籤 under 640px): modal, a scrim,
 * a grab handle, focus kept inside, Esc or the scrim closes it.
 */
export function BottomSheet({ open, onOpenChange, label, className, children }: BottomSheetProps) {
  const container = useTangentPortalContainer();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim" />
        <DialogPrimitive.Popup
          aria-modal="true"
          aria-label={label}
          className={cx("fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col overflow-auto rounded-t-tg-lg bg-tg-surface-raised pt-2 pr-3 pb-4.5 pl-4 text-tg-foreground shadow-tg-overlay outline-none", className)}
        >
          <span aria-hidden className="mx-auto mb-2 h-1 w-9 shrink-0 rounded-tg-full bg-tg-border-strong" />
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
