/**
 * The glossary's parts (F19), loaded the first time each is needed: the side
 * panel's 名詞表, the save dialog, 「之前問過」 in the selection toolbar and
 * what it opens. Only their places are in the main bundle.
 */
import { Component, lazy, Suspense, type ComponentProps, type ReactNode } from "react";
import { LazyRegion } from "../components/lazy-region";

const GlossaryPanelView = lazy(() => import("./glossary-panel"));
const TermDialogView = lazy(() => import("./term-dialog"));
const AskedBeforeChipView = lazy(() => import("./asked-before"));
const AskedBeforeDialogView = lazy(() => import("./asked-before").then((module) => ({ default: module.AskedBeforeDialog })));

export function LazyGlossaryPanel(props: ComponentProps<typeof GlossaryPanelView>) {
  return (
    <LazyRegion>
      <GlossaryPanelView {...props} />
    </LazyRegion>
  );
}

export function LazyTermDialog(props: ComponentProps<typeof TermDialogView>) {
  return (
    <LazyRegion>
      <TermDialogView {...props} />
    </LazyRegion>
  );
}

/** A failed load (or a failed render) of the hint shows nothing: the hint is optional, the toolbar's buttons are not. */
class NothingOnError extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Nothing shows while it loads either. */
export function LazyAskedBefore(props: ComponentProps<typeof AskedBeforeChipView>) {
  return (
    <NothingOnError>
      <Suspense fallback={null}>
        <AskedBeforeChipView {...props} />
      </Suspense>
    </NothingOnError>
  );
}

export function LazyAskedBeforeDialog(props: ComponentProps<typeof AskedBeforeDialogView>) {
  return (
    <LazyRegion>
      <AskedBeforeDialogView {...props} />
    </LazyRegion>
  );
}
