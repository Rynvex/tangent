import { useUiT } from "../provider";

/** "n 則未讀" before the first unread message of a line (A4): a primary rule with the count in the middle. */
export function UnreadDivider({ count }: { count: number }) {
  const t = useUiT();
  const label = t("unread.divider", { count });
  return (
    <div role="separator" aria-label={label} data-tg-unread="" className="mb-4 flex items-center gap-2.5 text-tg-xs font-semibold text-tg-primary-text">
      <span aria-hidden className="h-px flex-1 bg-tg-primary" />
      {label}
      <span aria-hidden className="h-px flex-1 bg-tg-primary" />
    </div>
  );
}
