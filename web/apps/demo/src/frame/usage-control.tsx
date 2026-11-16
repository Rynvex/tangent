import type { Usage } from "@tangent/client";
import { LazyRegion, UsageMeter, useOptionalShortcutText, usePreview, usageLevel, useUiT } from "@tangent/react";
import { lazy, useRef, useState } from "react";

const UsageBreakdown = lazy(() => import("./usage-host"));

/** Firefox keeps ⌘⇧P for itself (shortcut-groups.ts), so the hint names the palette there (decision #12). */
function isFirefox(): boolean {
  try {
    return typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent);
  } catch {
    return false;
  }
}

export interface UsageControlProps {
  lineId: string | null;
  usage: Usage;
  /** The full send preview (⌘⇧P). */
  onPreview: () => void;
  /** Phones and the embed: a bottom sheet. */
  narrow: boolean;
  /** A turn is running on the line: the level waits for it (its end invalidates the preview anyway). */
  busy?: boolean;
}

/** The level's background preview is reused this long (a finished turn or a notes change still invalidates it at once). */
const LEVEL_STALE_MS = 60_000;

/**
 * S7: the header's token meter as a button. It opens the context breakdown
 * (what the next turn sends, part by part); ⌘⇧P still opens the full send
 * preview, which the breakdown also links to. Its edge warns from 80 % of
 * the next turn's budget and turns destructive from 95 % (the empty-draft
 * preview of the line on screen, a free request that never calls a model).
 */
export function UsageControl({ lineId, usage, onPreview, narrow, busy = false }: UsageControlProps) {
  const t = useUiT();
  const meter = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  // A pointer press on the meter while open closes the panel (an outside press for it); the click that follows must not reopen it.
  const pressedOpen = useRef(false);
  // One empty-draft preview per line for the 80 / 95 % edge: not while a turn runs, reused for a minute, never on window focus.
  const preview = usePreview(lineId, "", lineId !== null && !busy, { staleTime: LEVEL_STALE_MS, refetchOnWindowFocus: false });
  const level = preview.data ? usageLevel(preview.data.totalTokens, preview.data.budget.total) : "normal";
  const previewKeys = useOptionalShortcutText("turn.preview");
  const paletteKeys = useOptionalShortcutText("palette.open");
  const tooltip = isFirefox() && paletteKeys ? t("usage.tooltipPalette", { keys: paletteKeys }) : previewKeys ? t("usage.tooltip", { keys: previewKeys }) : t("usage.title");
  const change = (next: boolean, restoreFocus = true) => {
    setOpen(next);
    if (next) {
      setUsed(true);
      return;
    }
    // Esc or a click elsewhere closes it; focus goes back to the meter (not when the full preview takes over).
    if (restoreFocus) requestAnimationFrame(() => meter.current?.focus({ preventScroll: true }));
  };
  const toggle = () => {
    const wasOpen = pressedOpen.current;
    pressedOpen.current = false;
    if (wasOpen && !open) return;
    change(!open);
  };
  return (
    <>
      <UsageMeter ref={meter} usage={usage} pressed={open} level={level} tooltip={tooltip} onClick={toggle} onPointerDown={() => (pressedOpen.current = open)} />
      {used && lineId && (
        <LazyRegion>
          <UsageBreakdown open={open} onOpenChange={(next) => change(next)} lineId={lineId} anchor={meter} sheet={narrow} onOpenPreview={() => {
            change(false, false);
            onPreview();
          }} />
        </LazyRegion>
      )}
    </>
  );
}
