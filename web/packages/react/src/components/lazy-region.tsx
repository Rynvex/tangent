import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { Button } from "./button";

export interface LazyRegionProps {
  children: ReactNode;
  /** Shown while the code loads; give it the region's size so nothing moves when it arrives. */
  fallback?: ReactNode;
  /** Classes of the failure box (its place in the layout: a column's width, an overlay's corner). */
  className?: string;
  /** What 重新載入 does (default: reload the page, which also picks up a redeploy's new chunks). */
  onReload?: () => void;
  /** Told about the error (a host's logging). */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

const reloadPage = () => window.location.reload();

function LoadFailed({ className, onReload }: { className?: string | undefined; onReload: () => void }) {
  const t = useUiT();
  return (
    <div role="alert" className={cx("flex flex-col items-start gap-2 p-3 text-tg-sm text-tg-muted", className)}>
      {t("ui.loadFailed")}
      <Button size="sm" onClick={onReload}>
        {t("ui.reload")}
      </Button>
    </div>
  );
}

class LoadBoundary extends Component<Omit<LazyRegionProps, "fallback">, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <LoadFailed className={this.props.className} onReload={this.props.onReload ?? reloadPage} />;
  }
}

/**
 * A part of the page loaded on demand (`React.lazy`): a placeholder while it
 * loads and, when its code cannot be fetched (offline, or an old chunk gone
 * after a redeploy), a 載入失敗 box with 重新載入 in its place, so only this
 * part fails instead of the whole page. A rejected lazy import stays
 * rejected, so the way back is a reload, not a retry.
 */
export function LazyRegion({ children, fallback = null, ...boundary }: LazyRegionProps) {
  return (
    <LoadBoundary {...boundary}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadBoundary>
  );
}
