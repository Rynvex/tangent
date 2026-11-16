/**
 * The F12 parts a transcript shows, loaded the first time they are needed:
 * an aside opened in place (S1) and the excerpt anchors' preview (S2). Only
 * the rows' place for them is in the main bundle; until an anchor's code
 * arrives its words show as plain text.
 */
import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import { LazyRegion } from "../components/lazy-region";

const AsideInlineCardView = lazy(() => import("./aside-inline-card"));
const ExcerptAnchorView = lazy(() => import("./excerpt-anchor"));

/** Holds a little height while the card's code loads, so the transcript barely moves. */
export function LazyAsideInlineCard(props: ComponentProps<typeof AsideInlineCardView>) {
  return (
    <LazyRegion fallback={<div aria-hidden className="min-h-16 rounded-tg-lg border border-dashed border-tg-leaf-answer" />}>
      <AsideInlineCardView {...props} />
    </LazyRegion>
  );
}

/** A failed load leaves the words as they are (no failure box inside a sentence). */
class PlainOnError extends Component<{ plain: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.plain : this.props.children;
  }
}

/** The words stay plain while the anchor's code loads (and if it fails to). */
export function LazyExcerptAnchor(props: ComponentProps<typeof ExcerptAnchorView> & { children: ReactNode }) {
  return (
    <PlainOnError plain={props.children}>
      <Suspense fallback={props.children}>
        <ExcerptAnchorView {...props} />
      </Suspense>
    </PlainOnError>
  );
}
