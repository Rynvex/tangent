import { RELATION_KINDS, type Link, type RelationKind } from "@tangent/client";
import { SegmentedControl } from "../components/segmented-control";
import { useP2T, type P2MessageKey } from "../i18n/p2-messages";
import { cx } from "../lib/cx";

export const RELATION_KIND_KEYS: Readonly<Record<RelationKind, P2MessageKey>> = {
  related: "relation.kind.related",
  supports: "relation.kind.supports",
  contradicts: "relation.kind.contradicts",
  depends_on: "relation.kind.depends_on",
};

/** A relation's kind; `related` for one from a server before B15. */
export const relationKindOf = (link: Pick<Link, "relationKind">): RelationKind => link.relationKind ?? "related";

/** The four kinds as a switch (B15): 相關 first, the default. */
export function RelationKindPicker({ value, onValueChange, className }: { value: RelationKind; onValueChange: (kind: RelationKind) => void; className?: string }) {
  const t = useP2T();
  return (
    <SegmentedControl label={t("relation.kindField")} options={RELATION_KINDS.map((kind) => ({ value: kind, label: t(RELATION_KIND_KEYS[kind]) }))} value={value} onValueChange={onValueChange} className={className} />
  );
}

/** The kind as a small chip; nothing for `related` (the plain case). Contradictions use the warning tone. */
export function RelationKindChip({ kind, className }: { kind: RelationKind; className?: string }) {
  const t = useP2T();
  if (kind === "related") return null;
  return (
    <span
      className={cx(
        "inline-flex h-5 shrink-0 items-center rounded-tg-sm border px-1.5 text-[0.6875rem] font-medium",
        kind === "contradicts" ? "border-tg-warning bg-tg-warning-soft text-tg-foreground" : "border-tg-border-strong text-tg-muted",
        className,
      )}
    >
      {t(RELATION_KIND_KEYS[kind])}
    </span>
  );
}
