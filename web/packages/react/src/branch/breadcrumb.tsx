import type { BranchKind } from "@tangent/client";
import { ChevronRight } from "lucide-react";
import { KIND_ICONS } from "../conversation/branch-suggestions";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

export interface BreadcrumbItem {
  /** The line's id. */
  id: string;
  label: string;
  /** Set on branches: the kind's icon leads the segment. */
  kind?: BranchKind;
}

/** Segment widths (components.md): 320 in the app, 170 embedded, 120 on phones. */
export type BreadcrumbSize = "app" | "embed" | "phone";

const MAX_WIDTH: Record<BreadcrumbSize, string> = {
  app: "max-w-80",
  embed: "max-w-[10.625rem]",
  phone: "max-w-30",
};

export interface BreadcrumbProps {
  /** From the main line down to the current line (the last item). */
  items: readonly BreadcrumbItem[];
  onSelect?: (lineId: string) => void;
  size?: BreadcrumbSize;
  className?: string;
}

const SEGMENT = "flex h-7.5 min-w-0 items-center gap-1.5 rounded-tg-sm px-2 text-tg-sm";

/** Keeps the first and the last item and folds the middle into one "…" (narrow frames with three or more levels). */
function visible(items: readonly BreadcrumbItem[], size: BreadcrumbSize): Array<BreadcrumbItem | { folded: BreadcrumbItem[] }> {
  if (size === "app" || items.length <= 2) return [...items];
  return [items[0]!, { folded: items.slice(1, -1) }, items.at(-1)!];
}

/**
 * The path of the conversation (components.md h30, A2 A4): main line ›
 * branch › sub-branch. Earlier levels are buttons, the current one carries
 * `aria-current="page"`; long purposes truncate, and narrow frames fold the
 * middle levels into "…" (which goes up one level).
 */
export function Breadcrumb({ items, onSelect, size = "app", className }: BreadcrumbProps) {
  const t = useUiT();
  const entries = visible(items, size);
  const parent = items.at(-2);
  return (
    <nav aria-label={t("breadcrumb.label")} className={cx("flex min-w-0 items-center overflow-hidden", className)}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-0.5 p-0">
        {entries.map((entry, index) => {
          const separator = index > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-tg-subtle" />;
          if ("folded" in entry) {
            return (
              <li key="folded" className="flex shrink-0 items-center gap-0.5">
                  {separator}
                  <button
                    type="button"
                    title={entry.folded.map((item) => item.label).join(" › ")}
                    onClick={() => parent && onSelect?.(parent.id)}
                    className={cx(SEGMENT, "text-tg-muted hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring")}
                  >
                    …
                  </button>
              </li>
            );
          }
          const current = index === entries.length - 1;
          const body = (
            <>
              {entry.kind && <span className="flex shrink-0 text-tg-branch-open [&_svg]:size-3.5">{KIND_ICONS[entry.kind]}</span>}
              <span className="min-w-[2em] truncate">{entry.label}</span>
            </>
          );
          return (
            <li key={entry.id} className={cx("flex min-w-0 items-center gap-0.5", current ? "shrink" : "shrink-[2]")}>
              {separator}
              {current ? (
                <span aria-current="page" title={entry.label} className={cx(SEGMENT, MAX_WIDTH[size], "font-semibold text-tg-foreground-strong")}>
                  {body}
                </span>
              ) : (
                <button
                  type="button"
                  title={entry.label}
                  onClick={() => onSelect?.(entry.id)}
                  className={cx(SEGMENT, MAX_WIDTH[size], "text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring")}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
