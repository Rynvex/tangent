import { lazy, useCallback, useRef, useState, type ComponentPropsWithRef, type ReactNode, type Ref } from "react";
import { cx } from "../lib/cx";
import { PRESSABLE } from "./button";
import { LazyRegion } from "./lazy-region";

export interface IconButtonProps extends Omit<ComponentPropsWithRef<"button">, "children" | "aria-label"> {
  /** The accessible name; also the tooltip text. */
  label: string;
  icon: ReactNode;
  size?: "md" | "sm";
  /** Shown after the label in the tooltip, e.g. a `<ShortcutKeys>` for the action. */
  shortcut?: ReactNode;
  /** Set to show the button as selected (ghost selected state, components.md). */
  pressed?: boolean;
  /** Defaults to true; turn off where a visible label sits next to the button. */
  tooltip?: boolean;
  /** A circle instead of the default rounded square (e.g. the composer's send button). */
  round?: boolean;
  /** `ghost` (default) or a filled `primary` (send). */
  variant?: "ghost" | "primary";
}

const VARIANTS = {
  ghost: "text-tg-muted enabled:not-aria-disabled:hover:bg-tg-accent enabled:not-aria-disabled:hover:text-tg-foreground aria-pressed:bg-tg-primary-soft aria-pressed:text-tg-primary-text",
  primary: "bg-tg-primary text-tg-primary-foreground enabled:not-aria-disabled:hover:bg-tg-primary-hover",
} as const;

const SIZES = {
  md: "size-(--tg-control-height) min-w-(--tg-hit-target) min-h-(--tg-hit-target)",
  sm: "size-(--tg-control-height-sm) min-w-(--tg-hit-target) min-h-(--tg-hit-target)",
} as const;

/** The hint (Base UI's tooltip) loads the first time a hinted button is pointed at or focused (F9: keeps it out of the main bundle). */
const TooltipHint = lazy(() => import("./tooltip-hint"));

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/** A square (or round) icon button with a required label and, by default, a hint (its label and shortcut) on hover or keyboard focus. */
export function IconButton({ label, icon, size = "md", shortcut, pressed, tooltip = true, round = false, variant = "ghost", type = "button", className, ref, onPointerEnter, onFocus, ...rest }: IconButtonProps) {
  const own = useRef<HTMLButtonElement | null>(null);
  const [armed, setArmed] = useState(false);
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      own.current = node;
      assignRef(ref, node);
    },
    [ref],
  );
  return (
    <>
      <button
        ref={setRef}
        type={type}
        aria-label={label}
        aria-pressed={pressed}
        onPointerEnter={(event) => {
          if (tooltip && event.pointerType !== "touch") setArmed(true);
          onPointerEnter?.(event);
        }}
        onFocus={(event) => {
          if (tooltip) setArmed(true);
          onFocus?.(event);
        }}
        className={cx(PRESSABLE, SIZES[size], "shrink-0 [&_svg]:size-4", VARIANTS[variant], round ? "rounded-tg-full" : "rounded-tg-sm", className)}
        {...rest}
      >
        {icon}
      </button>
      {tooltip && armed && (
        <LazyRegion>
          <TooltipHint
            anchor={own}
            content={
              <>
                {label}
                {shortcut}
              </>
            }
          />
        </LazyRegion>
      )}
    </>
  );
}
