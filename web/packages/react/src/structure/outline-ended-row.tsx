import type { OutlineEndedKind, OutlineItem } from "@tangent/client";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Layers } from "lucide-react";
import type { BundleTranslate } from "../i18n/bundle";
import type { OutlineGroupsMessageKey } from "../i18n/outline-groups-messages";
import { LEAF_ICONS, LEAF_KIND_KEYS, LEAF_TEXT } from "../leaf/leaf-meta";
import { cx } from "../lib/cx";

/** The same indent as the branch rows (outline-row.tsx). */
const INDENT_REM = 1;

/** A group's name: the leaf kind's, or 其他. */
export function endedKindName(kind: OutlineEndedKind, t: BundleTranslate<OutlineGroupsMessageKey>): string {
  return kind === "other" ? t("outlineGroups.other") : t(LEAF_KIND_KEYS[kind]);
}

/** The row's text, for its name and for typeahead. */
export function endedRowLabel(item: OutlineItem, t: BundleTranslate<OutlineGroupsMessageKey>): string {
  if (item.group) return t("outlineGroups.groupLabel", { kind: endedKindName(item.group.kind, t), count: item.group.count });
  if (item.toggle) return item.toggle.grouped ? t("outlineGroups.showAll", { count: item.toggle.count }) : t("outlineGroups.group");
  return "";
}

export interface OutlineEndedRowProps {
  item: OutlineItem;
  isFocused: boolean;
  t: BundleTranslate<OutlineGroupsMessageKey>;
  rowRef: (element: HTMLDivElement | null) => void;
  onFocus: () => void;
  /** A group opens or closes; the toggle groups or shows all. */
  onActivate: () => void;
}

/**
 * A row of the outline's grouped ended branches (F9 B.4): one per leaf kind
 * (a treeitem whose children are those branches, closed by default) and the
 * toggle row at the end of the parent's children.
 */
export function OutlineEndedRow({ item, isFocused, t, rowRef, onFocus, onActivate }: OutlineEndedRowProps) {
  const group = item.group;
  const kind = group?.kind;
  const Icon = kind && kind !== "other" ? LEAF_ICONS[kind] : Layers;
  return (
    <div
      ref={rowRef}
      role="treeitem"
      data-tg-outline-ended={group ? "group" : "toggle"}
      aria-label={endedRowLabel(item, t)}
      aria-level={item.level}
      aria-setsize={item.setSize}
      aria-posinset={item.posInSet}
      aria-expanded={group ? item.expanded : undefined}
      tabIndex={isFocused ? 0 : -1}
      onFocus={onFocus}
      onClick={onActivate}
      style={{ paddingInlineStart: `${0.375 + (item.level - 1) * INDENT_REM}rem` }}
      className={cx(
        "grid min-h-9 cursor-pointer grid-cols-[1rem_1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-tg-sm py-1.75 pr-2.5 text-tg-xs outline-none select-none pointer-coarse:min-h-11",
        "hover:outline hover:outline-1 hover:outline-tg-border-strong focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-tg-ring",
        group ? "text-tg-foreground" : "text-tg-primary-text",
      )}
    >
      <span aria-hidden className="flex text-tg-muted">
        {group ? item.expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" /> : null}
      </span>
      <span aria-hidden className={cx("flex [&_svg]:size-3.5", kind && kind !== "other" ? LEAF_TEXT[kind] : "text-tg-muted")}>
        {group ? <Icon /> : item.toggle?.grouped ? <ChevronsUpDown /> : <ChevronsDownUp />}
      </span>
      <span aria-hidden className="truncate">
        {group ? endedKindName(group.kind, t) : endedRowLabel(item, t)}
      </span>
      {group && (
        <span aria-hidden className="text-tg-muted">
          {t("outlineGroups.count", { count: group.count })}
        </span>
      )}
    </div>
  );
}
