import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { PreviewTurnResult } from "@tangent/client";
import { ArrowRight } from "lucide-react";
import type { RefObject } from "react";
import { Skeleton } from "../components/display";
import { formatTokens } from "../components/usage-meter";
import { usePreview } from "../data/queries";
import { useF12T } from "../i18n/f12-messages";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";
import { groupPreviewBlocks } from "./models";

export interface UsageBreakdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineId: string;
  /** The header's token meter; the panel hangs under it (desktop). */
  anchor: RefObject<HTMLElement | null>;
  /** 送出前預覽完整內容: the full send preview (A11). */
  onOpenPreview: () => void;
  /** Phones: a bottom sheet instead of the panel. */
  sheet?: boolean;
}

const PERCENT = 100;

function Rows({ preview }: { preview: PreviewTurnResult }) {
  const t = useUiT();
  const rows = groupPreviewBlocks(preview.blocks, t);
  const total = Math.max(1, preview.totalTokens);
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((row, index) => {
        const share = Math.round((row.tokens / total) * PERCENT);
        return (
          <li key={`${row.key}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
            <span className="truncate text-tg-sm text-tg-foreground">{row.label}</span>
            <span className="font-tg-mono text-tg-xs text-tg-muted tabular-nums">{formatTokens(row.tokens)}</span>
            <span aria-hidden className="col-span-2 h-1.5 overflow-hidden rounded-tg-full bg-tg-surface-sunken">
              <span className="block h-full rounded-tg-full bg-tg-primary" style={{ width: `${Math.max(2, share)}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Body({ lineId, onOpenPreview }: { lineId: string; onOpenPreview: () => void }) {
  const t = useF12T();
  const preview = usePreview(lineId, "", true);
  const budget = preview.data?.budget.total ?? 0;
  const tokens = preview.data?.totalTokens ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-tg-sm font-semibold text-tg-foreground-strong">{t("usage.breakdownTitle")}</span>
        {preview.data && budget > 0 && (
          <span className="font-tg-mono text-tg-xs text-tg-muted">{t("usage.share", { tokens: formatTokens(tokens), budget: formatTokens(budget), percent: Math.round((tokens / budget) * PERCENT) })}</span>
        )}
      </div>
      {preview.isPending && (
        <div role="status" aria-label={t("usage.loading")} className="flex flex-col gap-2">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      )}
      {preview.isError && (
        <p role="alert" className="m-0 flex flex-wrap items-center gap-2 text-tg-sm text-tg-muted">
          {t("usage.loadFailed")}
          <button type="button" onClick={() => void preview.refetch()} className="text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
            {t("usage.retry")}
          </button>
        </p>
      )}
      {preview.data && <Rows preview={preview.data} />}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-tg-border pt-2.5">
        {preview.data?.model && <span className="text-tg-xs text-tg-muted">{t("usage.model", { model: preview.data.model })}</span>}
        <button
          type="button"
          onClick={onOpenPreview}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-tg-sm px-2 text-tg-xs font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11"
        >
          {t("usage.openPreview")}
          <ArrowRight aria-hidden className="size-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * S7 UsageBreakdown (w360; a bottom sheet on phones): the parts the next
 * turn sends with their tokens as bars, the share of the budget, and the
 * way to the full send preview. It only answers "why so many"; the details
 * stay in the send preview. Esc closes it and focus goes back to the meter
 * (the host's). It does not fade in.
 */
export default function UsageBreakdown({ open, onOpenChange, lineId, anchor, onOpenPreview, sheet = false }: UsageBreakdownProps) {
  const t = useF12T();
  const container = useTangentPortalContainer();
  const openPreview = () => {
    onOpenChange(false);
    onOpenPreview();
  };
  if (sheet) {
    return (
      <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
        <DialogPrimitive.Portal container={container ?? undefined}>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim" />
          <DialogPrimitive.Popup aria-modal="true" aria-label={t("usage.breakdownTitle")} className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col overflow-auto rounded-t-tg-lg bg-tg-surface-raised px-4 pt-3 pb-5 text-tg-foreground shadow-tg-overlay outline-none">
            <span aria-hidden className="mx-auto mb-2 h-1 w-9 rounded-tg-full bg-tg-border-strong" />
            {open && <Body lineId={lineId} onOpenPreview={openPreview} />}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <PopoverPrimitive.Portal container={container ?? undefined}>
        <PopoverPrimitive.Positioner anchor={anchor} side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-50">
          <PopoverPrimitive.Popup
            aria-label={t("usage.breakdownTitle")}
            className={cx("flex w-[min(22.5rem,calc(100vw-1rem))] flex-col rounded-tg border border-tg-border-strong bg-tg-surface-raised px-4 py-3.5 text-tg-foreground shadow-tg-overlay outline-none")}
          >
            {open && <Body lineId={lineId} onOpenPreview={openPreview} />}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
