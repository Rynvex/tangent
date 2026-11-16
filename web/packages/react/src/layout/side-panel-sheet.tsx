import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { IconButton } from "../components/icon-button";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";
import { SURFACE, type SidePanelProps } from "./side-panel";

/** The phone's side panel: a modal bottom sheet with a scrim, focus trap, a visible close button and Esc. */
export default function SheetPanel({ open, onOpenChange, label, className, children }: Omit<SidePanelProps, "mode">) {
  const t = useUiT();
  const container = useTangentPortalContainer();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-tg-scrim transition-opacity duration-(--tg-duration-normal) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          aria-label={label}
          className={cx(
            SURFACE,
            "fixed inset-x-0 top-24 bottom-0 z-40 rounded-t-[1.125rem] shadow-tg-overlay outline-none",
            "transition-transform duration-(--tg-duration-normal) ease-tg-out data-ending-style:translate-y-full data-starting-style:translate-y-full",
            className,
          )}
        >
          <div className="relative flex shrink-0 justify-center pt-2">
            <span aria-hidden className="h-1 w-9 rounded-tg-full bg-tg-border-strong" />
            <DialogPrimitive.Close render={<IconButton label={t("sidePanel.close")} icon={<X />} size="sm" tooltip={false} className="absolute top-1 right-2" />} />
          </div>
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
