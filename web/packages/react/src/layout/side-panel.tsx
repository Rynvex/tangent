import { lazy, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { LazyRegion } from "../components/lazy-region";
import { cx } from "../lib/cx";
import { isComposing } from "../shortcuts/keys";
import { ESCAPE_PRIORITY } from "../shortcuts/registry";
import { useEscapeLayer } from "../shortcuts/shortcuts-provider";

/**
 * How the side panel sits (handoff width rules): a `column` next to the
 * conversation (≥ 1100), an `overlay` over its right edge (1024–1099, 768,
 * and the 420 embed), or a bottom `sheet` on phones (375).
 */
export type SidePanelMode = "column" | "overlay" | "sheet";

export interface SidePanelProps {
  mode: SidePanelMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The landmark's name, e.g. 側欄. */
  label: string;
  className?: string;
  /** F12 S3: the column's width in px (360 by default); the host keeps it within its bounds. */
  width?: number;
  /** F12 S3: the column's resizer, at its left edge (the host's `SidePanelResizer`). */
  resizer?: ReactNode;
  children: ReactNode;
}

export const SURFACE = "flex min-h-0 flex-col overflow-hidden bg-tg-surface text-tg-foreground";

/**
 * Remembers what had focus when the overlay opened and returns focus there
 * when it closes, if focus was inside the panel (now gone) or nowhere.
 */
function useReturnFocus(active: boolean, panel: { current: HTMLElement | null }): void {
  const opener = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);
  useLayoutEffect(() => {
    if (active && !wasActive.current) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    if (!active && wasActive.current) {
      const focus = document.activeElement;
      const lost = !focus || focus === document.body || !focus.isConnected || panel.current?.contains(focus) === true;
      if (lost && opener.current?.isConnected) opener.current.focus();
      opener.current = null;
    }
    wasActive.current = active;
  }, [active, panel]);
}

/** The phone's bottom sheet (Base UI's dialog) loads only where a sheet is used (F9: out of the main bundle). */
const SheetPanel = lazy(() => import("./side-panel-sheet"));

/**
 * The side panel container. Columns and overlays are complementary landmarks.
 * An open overlay takes Esc through the shortcut provider (above `nav.back`;
 * without a provider, Esc inside the panel) and gives focus back to whatever
 * opened it. The phone sheet is a modal dialog with a scrim, focus trap, a
 * visible close button and Esc to close.
 */
export function SidePanel(props: SidePanelProps) {
  const { mode, open, onOpenChange, label, className, width, resizer, children } = props;
  const panel = useRef<HTMLElement | null>(null);
  const overlayOpen = mode === "overlay" && open;
  const handledByProvider = useEscapeLayer(overlayOpen, () => onOpenChange(false), ESCAPE_PRIORITY.panel);
  useReturnFocus(overlayOpen, panel);

  if (mode === "sheet") {
    return (
      <LazyRegion>
        <SheetPanel open={open} onOpenChange={onOpenChange} label={label} {...(className ? { className } : {})}>
          {children}
        </SheetPanel>
      </LazyRegion>
    );
  }
  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (handledByProvider || mode !== "overlay" || event.key !== "Escape" || event.defaultPrevented || isComposing(event)) return;
    event.preventDefault();
    onOpenChange(false);
  };

  return (
    <aside
      ref={panel}
      aria-label={label}
      data-mode={mode}
      onKeyDown={onKeyDown}
      {...(mode === "column" && width !== undefined ? { style: { width } } : {})}
      className={cx(
        SURFACE,
        mode === "column" && "relative w-90 shrink-0 border-l border-tg-border",
        mode === "overlay" && "absolute inset-y-0 right-0 z-40 w-[min(22.5rem,100%)] border-l border-tg-border shadow-tg-overlay",
        className,
      )}
    >
      {mode === "column" && resizer}
      {children}
    </aside>
  );
}
