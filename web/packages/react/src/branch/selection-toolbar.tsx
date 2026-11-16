import { hasSelectedText, resolveMessageSelection, type MessageSelection } from "@tangent/client";
import { BookA, GitBranch, NotebookPen, SquareParking, StickyNote, Zap } from "lucide-react";
import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";

/** Gap between the selection and the toolbar, and the toolbar's height (components.md h36). */
const GAP_PX = 8;
/** Half the widest toolbar (six actions on one row); narrower screens wrap it inside the margins. */
const HALF_WIDTH_PX = 280;
const VIEWPORT_MARGIN_PX = 8;

/** The selected text and its message, when the whole selection sits inside one message of `container` (for ⌘B and ⌘⇧N). */
export function readMessageSelection(container: Element | null): MessageSelection | null {
  if (typeof window === "undefined") return null;
  return resolveMessageSelection(window.getSelection(), container);
}

/** Whether the page has any text selected, usable or not (⌘⇧N tells "nothing selected" from "selected in the wrong place"). */
export function hasTextSelection(): boolean {
  return typeof window !== "undefined" && hasSelectedText(window.getSelection());
}

interface Placement {
  selection: MessageSelection;
  style: CSSProperties;
}

/** Above the selection on desktop, below it on touch screens (where the system's own menu sits above). */
function place(selection: MessageSelection): Placement {
  const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
  const rect = range && typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
  if (!rect) return { selection, style: { left: "50%", bottom: GAP_PX * 12, transform: "translateX(-50%)" } };
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const half = Math.min(HALF_WIDTH_PX, window.innerWidth / 2 - VIEWPORT_MARGIN_PX);
  const center = Math.min(Math.max(rect.left + rect.width / 2, half + VIEWPORT_MARGIN_PX), window.innerWidth - half - VIEWPORT_MARGIN_PX);
  return coarse
    ? { selection, style: { left: center, top: rect.bottom + GAP_PX, transform: "translateX(-50%)" } }
    : { selection, style: { left: center, top: rect.top - GAP_PX, transform: "translate(-50%, -100%)" } };
}

export interface SelectionToolbarProps {
  /** The message list: only selections inside one of its `[data-message-id]` rows count. */
  containerRef: RefObject<HTMLElement | null>;
  /** 開支線 from the selection; absent where nothing can fork (F11 §1: inside an aside). */
  onBranch?: (selection: MessageSelection) => void;
  /** F10 ⚡ 秒問解釋: no dialog, an aside with the default question sent at once (forkable selections only). */
  onQuickAsk?: (selection: MessageSelection) => void;
  /** Notes feature (F3). */
  onNote?: (selection: MessageSelection) => void;
  /** Parking feature (P1). */
  onPark?: (selection: MessageSelection) => void;
  /** The memo feature (B13; F10: outside focus mode too): a memo on the line on screen, not sent to the AI. */
  onMemo?: (selection: MessageSelection) => void;
  /** The glossary feature (F19): 存進名詞表, the selection as a term or as its explanation. */
  onTerm?: (selection: MessageSelection) => void;
  /**
   * F19 §2.4: something to say about the selection, under the buttons (「之前問過：…」). It renders nothing until it
   * has something; `close` clears the selection and the toolbar, as a button does.
   */
  hint?: (selection: MessageSelection, close: () => void) => ReactNode;
  className?: string;
}

function ToolButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  // Pressing must not clear the selection the action is about.
  const keep = (event: MouseEvent) => event.preventDefault();
  return (
    <button
      type="button"
      onMouseDown={keep}
      onClick={onClick}
      className="inline-flex h-7.5 items-center gap-1.5 rounded-tg-sm px-2.5 text-tg-xs whitespace-nowrap text-tg-background hover:bg-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring pointer-coarse:h-11"
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The toolbar over selected text (A2; components.md h36, dark, gap 2):
 * "branch from this" and, when the host wires them, 秒問解釋 (F10, first),
 * "save to notes", "park" and 記成備忘. It appears only for a selection inside one message of the list,
 * above it on desktop and below it on touch screens, and moves with the
 * selection when the page scrolls or resizes. Inside a conclusion card or a
 * move marker (not forkable) it offers only "save to notes", and does not
 * appear when that is not wired.
 */
export function SelectionToolbar({ containerRef, onBranch, onQuickAsk, onNote, onPark, onMemo, onTerm, hint, className }: SelectionToolbarProps) {
  const t = useUiT();
  const portal = useTangentPortalContainer();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const canNote = onNote !== undefined || onMemo !== undefined || onTerm !== undefined;
  // A forkable selection still needs one action that uses it (without 開支線, only 秒問解釋 or 停車 do).
  const canFork = onBranch !== undefined || onQuickAsk !== undefined || onPark !== undefined;

  useEffect(() => {
    const update = () => {
      const selection = readMessageSelection(containerRef.current);
      setPlacement(selection && ((selection.forkable && canFork) || canNote) ? place(selection) : null);
    };
    // It sits at fixed coordinates, so it follows the selection when anything scrolls (capture: inner scrollers too) or resizes.
    const options = { capture: true, passive: true } as const;
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, options);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, options);
      window.removeEventListener("resize", update);
    };
  }, [containerRef, canNote, canFork]);

  if (!placement) return null;
  const { forkable } = placement.selection;
  const close = () => {
    window.getSelection()?.removeAllRanges();
    setPlacement(null);
  };
  const run = (action: (selection: MessageSelection) => void) => () => {
    action(placement.selection);
    close();
  };
  const toolbar = (
    // As wide as its buttons (a fixed box would otherwise shrink to the room right of its anchor and wrap them), never wider than the screen.
    <div
      role="toolbar"
      aria-label={t("selection.toolbar")}
      style={placement.style}
      className={cx("fixed z-50 flex w-max max-w-[calc(100vw-1rem)] flex-col rounded-tg bg-tg-foreground-strong p-0.75 font-tg-sans shadow-tg-overlay", className)}
    >
      <div className="flex flex-wrap justify-center gap-0.5">
        {forkable && onQuickAsk && <ToolButton icon={<Zap aria-hidden className="size-3.5" />} label={t("selection.quickAsk")} onClick={run(onQuickAsk)} />}
        {forkable && onBranch && <ToolButton icon={<GitBranch aria-hidden className="size-3.5" />} label={t("selection.branch")} onClick={run(onBranch)} />}
        {forkable && onPark && <ToolButton icon={<SquareParking aria-hidden className="size-3.5" />} label={t("composer.park")} onClick={run(onPark)} />}
        {onNote && <ToolButton icon={<NotebookPen aria-hidden className="size-3.5" />} label={t("asideNote.save")} onClick={run(onNote)} />}
        {onMemo && <ToolButton icon={<StickyNote aria-hidden className="size-3.5" />} label={t("selection.memo")} onClick={run(onMemo)} />}
        {onTerm && <ToolButton icon={<BookA aria-hidden className="size-3.5" />} label={t("selection.term")} onClick={run(onTerm)} />}
      </div>
      {/* F19 §2.4: a row of its own under the buttons, when there is something to say. */}
      {hint?.(placement.selection, close)}
    </div>
  );
  return portal ? createPortal(toolbar, portal) : toolbar;
}
