/**
 * The memory parts other components show (F6 phase 3), loaded the first time
 * they are needed: the branch form's hint, the recall above a new conversation
 * and the notes' footer. Each loads in its own `LazyRegion`: nothing while it
 * loads, and a small load failure in its place (R11) when its code cannot be
 * fetched, so the form, the composer and the notes stay.
 */
import { lazy, type ComponentProps } from "react";
import { LazyRegion } from "../components/lazy-region";

const BranchMemoryRecallView = lazy(() => import("./branch-memory-recall"));
const MemoryRecallView = lazy(() => import("./memory-recall"));
const MemoryFooterView = lazy(() => import("./memory-footer"));

/** `BranchMemoryRecall`, downloaded the first time it shows. */
export function LazyBranchMemoryRecall(props: ComponentProps<typeof BranchMemoryRecallView>) {
  return (
    <LazyRegion>
      <BranchMemoryRecallView {...props} />
    </LazyRegion>
  );
}

/** `MemoryRecall`, downloaded the first time it shows. */
export function LazyMemoryRecall(props: ComponentProps<typeof MemoryRecallView>) {
  return (
    <LazyRegion>
      <MemoryRecallView {...props} />
    </LazyRegion>
  );
}

/** `MemoryFooter`, downloaded the first time it shows. */
export function LazyMemoryFooter(props: ComponentProps<typeof MemoryFooterView>) {
  return (
    <LazyRegion>
      <MemoryFooterView {...props} />
    </LazyRegion>
  );
}
