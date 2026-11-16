/**
 * The P3 parts a transcript shows (F6), loaded the first time they are
 * needed: the argument tag control, the fold block, the diverge marker and (F8) the conclusion card. Only the rows' place
 * for them is in the main bundle. Each loads in its own `LazyRegion`: nothing
 * while it loads, and a small load failure in its place (R11) when its code
 * cannot be fetched, so the rest of the transcript stays.
 */
import { lazy, type ComponentProps } from "react";
import { LazyRegion } from "../components/lazy-region";

const ArgTagView = lazy(() => import("../p3/arg-tag"));
const FoldBlockView = lazy(() => import("../p3/fold-block"));
const DivergeMarkerView = lazy(() => import("../p3/diverge-marker"));
/** F8: a conclusion card (and its 前提已更新 badge) loads with the first card on screen, out of the main bundle. */
const BranchCardView = lazy(() => import("../branch/branch-card").then((module) => ({ default: module.BranchCard })));

export function LazyArgTag(props: ComponentProps<typeof ArgTagView>) {
  return (
    <LazyRegion>
      <ArgTagView {...props} />
    </LazyRegion>
  );
}

export function LazyFoldBlock(props: ComponentProps<typeof FoldBlockView>) {
  return (
    <LazyRegion>
      <FoldBlockView {...props} />
    </LazyRegion>
  );
}

export function LazyDivergeMarker(props: ComponentProps<typeof DivergeMarkerView>) {
  return (
    <LazyRegion>
      <DivergeMarkerView {...props} />
    </LazyRegion>
  );
}

/** Holds a collapsed card's height while its code loads, so the transcript does not jump. */
export function LazyBranchCard(props: ComponentProps<typeof BranchCardView>) {
  return (
    <LazyRegion fallback={<div aria-hidden className="min-h-24 rounded-tg-lg border border-tg-border bg-tg-surface-sunken" />}>
      <BranchCardView {...props} />
    </LazyRegion>
  );
}
