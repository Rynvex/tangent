import { leafPresentation, type LeafSummary } from "@tangent/client";
import { cx } from "../lib/cx";
import { useP1T } from "../i18n/p1-messages";
import { LEAF_ICONS, LEAF_KIND_KEYS, LEAF_TEXT } from "./leaf-meta";

export { LEAF_ICONS, LEAF_KIND_KEYS, LEAF_TEXT } from "./leaf-meta";

export interface LeafProps {
  leaf: LeafSummary & { aiDrafted?: boolean };
  /** Shows the kind's name before the line (the branch bar); otherwise only screen readers hear it. */
  showKind?: boolean;
  /** Wraps a long line instead of cutting it with an ellipsis. */
  wrap?: boolean;
  className?: string;
}

/**
 * A branch's leaf (B1; components.md one line, icon 12, gap 4): the kind's
 * icon in its colour and the line. An AI draft is dashed and says
 * 「AI 草稿・待你確認」; a leaf AI wrote in auto mode says 「AI 做的」.
 */
export function Leaf({ leaf, showKind = false, wrap = false, className }: LeafProps) {
  const t = useP1T();
  const Icon = LEAF_ICONS[leaf.kind];
  const state = leafPresentation(leaf);
  const kind = t(LEAF_KIND_KEYS[leaf.kind]);
  return (
    <span
      data-tg-leaf={leaf.kind}
      data-leaf-state={state}
      className={cx(
        "inline-flex max-w-full min-w-0 items-center gap-1 text-tg-xs text-tg-muted",
        wrap && "flex-wrap",
        state === "draft" && "rounded-tg-sm border border-dashed border-tg-suggestion px-1.5 py-0.5",
        className,
      )}
    >
      <Icon aria-hidden className={cx("size-3 shrink-0", LEAF_TEXT[leaf.kind])} />
      {showKind ? <span className={cx("shrink-0 font-semibold", LEAF_TEXT[leaf.kind])}>{kind}</span> : <span className="sr-only">{t("leaf.kindPrefix", { kind })}</span>}
      <span className={cx("min-w-0", wrap ? "break-words" : "truncate")}>{leaf.line}</span>
      {state === "draft" && <span className="shrink-0 text-tg-suggestion">{t("leaf.draftBadge")}</span>}
      {state === "ai" && <span className="shrink-0 rounded-tg-full bg-tg-accent px-1.5 text-tg-muted">{t("leaf.aiBadge")}</span>}
    </span>
  );
}
