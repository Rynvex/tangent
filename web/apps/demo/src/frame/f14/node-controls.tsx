/**
 * F16.1: the small controls S2's sessions share in both columns: the
 * checkbox of the multi-select (Shift+click or Shift+Space selects a range)
 * and the drag handle (drag it, or Alt+Up and Alt+Down while it has focus).
 */
import { GripVertical } from "lucide-react";
import { useRef, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { cx } from "../cx";

export interface SelectBoxProps {
  checked: boolean;
  label: string;
  touch: boolean;
  /** `range`: Shift was held (select everything from the last one toggled). */
  onToggle: (range: boolean) => void;
}

/** A native checkbox, so Shift with a click or with Space can be told apart. */
export function SelectBox({ checked, label, touch, onToggle }: SelectBoxProps) {
  const shiftSpace = useRef(false);
  const box = (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      data-tg-select-box=""
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === " ") shiftSpace.current = event.shiftKey;
      }}
      onClick={(event: MouseEvent<HTMLInputElement>) => {
        const range = event.shiftKey || shiftSpace.current;
        shiftSpace.current = false;
        onToggle(range);
      }}
      onBlur={() => {
        shiftSpace.current = false;
      }}
      onChange={() => undefined}
      className={cx("shrink-0 cursor-pointer accent-tg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring", touch ? "size-5.5" : "size-4")}
    />
  );
  // Phones: a 44px area around the box toggles it too (no Shift there).
  return touch ? <label className="grid size-11 shrink-0 cursor-pointer place-items-center">{box}</label> : box;
}

export interface DragHandleProps {
  label: string;
  /** Marks the left column's handle (`data-tg-handle`) or the preview's (`data-tg-preview-handle`). */
  variant: "card" | "preview";
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (delta: number) => void;
  className?: string;
}

export function DragHandle({ label, variant, onDragStart, onDragEnd, onMove, className }: DragHandleProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    onMove(event.key === "ArrowUp" ? -1 : 1);
  };
  return (
    <button
      type="button"
      draggable
      {...(variant === "card" ? { "data-tg-handle": "" } : { "data-tg-preview-handle": "" })}
      onDragStart={(event: DragEvent<HTMLButtonElement>) => {
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", label);
        }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      aria-label={label}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      className={cx("grid w-5.5 shrink-0 cursor-grab place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", className ?? "h-7")}
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  );
}
