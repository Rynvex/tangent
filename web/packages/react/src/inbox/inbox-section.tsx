import { useId, type ReactNode } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { useP1T } from "../i18n/p1-messages";

/** What a section's list needs from its query. */
export interface ListQuery<T> {
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
  items: readonly T[];
}

/** One part of 待處理: an icon, a title and a count, then its cards. */
export function Section({ icon, title, count, action, children }: { icon: ReactNode; title: string; count: string; action?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <div className="flex min-h-6.5 items-center gap-2">
        <h3 id={headingId} className="m-0 flex min-w-0 flex-1 items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
          {icon}
          {title}
          <span className="font-normal text-tg-subtle">{count}</span>
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Loading, failed (with retry), empty, or the items. */
export function ListState<T>({ query, empty, children }: { query: ListQuery<T>; empty: string; children: ReactNode }) {
  const t = useP1T();
  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm text-tg-muted">
        {t("inbox.loadFailed")}
        <Button size="sm" onClick={() => void query.refetch()}>
          {t("inbox.retry")}
        </Button>
      </div>
    );
  }
  if (query.items.length === 0) return <p className="m-0 px-1 py-2 text-tg-sm text-tg-muted">{empty}</p>;
  return <>{children}</>;
}
