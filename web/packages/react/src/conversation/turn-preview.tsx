import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { PreviewTurnResult, Usage } from "@tangent/client";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import { useEscapeLayer } from "../shortcuts/shortcuts-provider";
import { IconButton } from "../components/icon-button";
import { Skeleton } from "../components/display";
import { usePreview } from "../data/queries";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";
import { formatTokens } from "../components/usage-meter";
import { formatUsd, groupPreviewBlocks, type PreviewRow } from "./models";
import { BudgetSection, FisheyeSection } from "./preview-fisheye";
import { FoldsSection } from "./preview-folds";
import { MemoriesSection } from "./preview-memories";

export interface TurnPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineId: string;
  /** The draft that would be sent ("" previews an empty next message). */
  content: string;
  /** The line's running totals, shown at the bottom. */
  lineUsage?: Usage | null;
  /**
   * `dialog` (default): a modal drawer, the phone layout. `panel`: a
   * non-modal panel docked in the conversation column (desktop, DESIGN §12),
   * so the draft can be edited while the preview follows it.
   */
  mode?: "dialog" | "panel";
  className?: string;
}

function Row({ row }: { row: PreviewRow }) {
  const t = useUiT();
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-tg-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-10 w-full items-center gap-2 rounded-tg-sm px-2 text-left text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
      >
        {open ? <ChevronDown aria-hidden className="size-3 shrink-0 text-tg-muted" /> : <ChevronRight aria-hidden className="size-3 shrink-0 text-tg-muted" />}
        <span className="min-w-0 flex-1 truncate text-tg-sm">{row.label}</span>
        <span className="w-14 shrink-0 text-right font-tg-mono text-tg-xs text-tg-muted">{formatTokens(row.tokens)}</span>
      </button>
      {open && (
        <div className="mr-2 mb-2 ml-7 flex flex-col gap-1.5">
          {row.blocks.map((block, index) => (
            <pre key={index} className="m-0 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 font-tg-sans text-tg-xs whitespace-pre-wrap text-tg-muted">
              {block.role && <span className="font-semibold text-tg-foreground">{block.role === "user" ? t("message.you") : t("message.assistant")}: </span>}
              {block.content || t("preview.empty")}
            </pre>
          ))}
        </div>
      )}
    </li>
  );
}

function Totals({ preview }: { preview: PreviewTurnResult }) {
  const t = useUiT();
  return (
    <div className="flex flex-col gap-1 border-b border-tg-border px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <span className="font-tg-mono text-tg-xl font-semibold text-tg-foreground-strong">{preview.totalTokens.toLocaleString()}</span>
        <span className="text-tg-sm text-tg-muted">{t("preview.tokenUnit")}</span>
      </div>
      <span className="text-tg-xs text-tg-muted">
        {preview.estimatedCostUsd !== undefined ? t("preview.cost", { cost: formatUsd(preview.estimatedCostUsd) }) : t("preview.noPrice")}
      </span>
      {preview.model && <span className="text-tg-xs text-tg-muted">{t("preview.model", { model: preview.provider ? `${preview.provider} / ${preview.model}` : preview.model })}</span>}
    </div>
  );
}

function Body({ lineId, content, lineUsage }: Omit<TurnPreviewProps, "open" | "onOpenChange">) {
  const t = useUiT();
  const preview = usePreview(lineId, content, true);
  if (preview.isPending) {
    return (
      <div role="status" aria-label={t("preview.loading")} className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }
  if (preview.isError) {
    return (
      <p role="alert" className="m-0 p-4 text-tg-sm text-tg-destructive">
        {t("preview.failed")}
      </p>
    );
  }
  const rows = groupPreviewBlocks(preview.data.blocks, t);
  return (
    <>
      <Totals preview={preview.data} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-2">
          {rows.map((row, index) => (
            <Row key={`${row.key}-${index}`} row={row} />
          ))}
        </ul>
        {/* B9 phase B: the shared budget always; what the model sees with fisheye on (C1). */}
        <BudgetSection budget={preview.data.budget} />
        {preview.data.fisheye && <FisheyeSection report={preview.data.fisheye} lineId={lineId} />}
        {preview.data.folds && preview.data.folds.length > 0 && <FoldsSection folds={preview.data.folds} lineId={lineId} />}
        {preview.data.memories && preview.data.memories.length > 0 && <MemoriesSection memories={preview.data.memories} />}
      </div>
      {lineUsage && (
        <p className="m-0 border-t border-tg-border px-4 py-3 text-tg-xs text-tg-muted">
          {t("preview.lineUsage", { tokens: formatTokens(lineUsage.inputTokens + lineUsage.outputTokens), cost: formatUsd(lineUsage.costUsd) })}
        </p>
      )}
    </>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  const t = useUiT();
  return (
    <header className="flex items-start gap-2 border-b border-tg-border px-4 pt-3.5 pb-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="m-0 text-tg-md font-semibold text-tg-foreground-strong">{t("preview.title")}</h2>
        <p className="m-0 text-tg-xs text-tg-muted">{t("preview.description")}</p>
      </div>
      <IconButton label={t("ui.close")} icon={<X />} size="sm" tooltip={false} onClick={onClose} />
    </header>
  );
}

/** The docked, non-modal form: a labelled region; Esc inside it (or with nothing else open) closes it. */
function PreviewPanel({ open, onOpenChange, className, ...body }: Omit<TurnPreviewProps, "mode">) {
  const t = useUiT();
  useEscapeLayer(open, () => onOpenChange(false));
  if (!open) return null;
  return (
    <section
      aria-label={t("preview.title")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
      }}
      className={cx("flex w-[min(25rem,100%)] shrink-0 flex-col overflow-hidden border-l border-tg-border bg-tg-surface-raised text-tg-foreground", className)}
    >
      <Header onClose={() => onOpenChange(false)} />
      <Body {...body} />
    </section>
  );
}

/**
 * The send preview (A11, C1; components.md w 400, rows h 40): the blocks
 * of the next prompt with their tokens, expandable to their text, the total,
 * the estimated input cost when the server prices the model, how the budget
 * was spent, what the model sees item by item (fisheye on), and the line's
 * running totals. Nothing is sent; read-only identities may open it.
 */
export function TurnPreview({ open, onOpenChange, mode = "dialog", className, ...body }: TurnPreviewProps) {
  if (mode === "panel") return <PreviewPanel open={open} onOpenChange={onOpenChange} {...(className ? { className } : {})} {...body} />;
  return <PreviewDrawer open={open} onOpenChange={onOpenChange} {...body} />;
}

function PreviewDrawer({ open, onOpenChange, ...body }: Omit<TurnPreviewProps, "mode" | "className">) {
  const t = useUiT();
  const container = useTangentPortalContainer();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim transition-opacity duration-(--tg-duration-normal) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          className={cx(
            "fixed inset-y-0 right-0 z-50 flex w-[min(25rem,100%)] flex-col overflow-hidden border-l border-tg-border bg-tg-surface-raised text-tg-foreground shadow-tg-overlay outline-none",
            "transition-transform duration-(--tg-duration-normal) ease-tg-out data-ending-style:translate-x-full data-starting-style:translate-x-full",
          )}
        >
          <header className="flex items-start gap-2 border-b border-tg-border px-4 pt-3.5 pb-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <DialogPrimitive.Title className="m-0 text-tg-md font-semibold text-tg-foreground-strong">{t("preview.title")}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="m-0 text-tg-xs text-tg-muted">{t("preview.description")}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close render={<IconButton label={t("ui.close")} icon={<X />} size="sm" tooltip={false} />} />
          </header>
          {open && <Body {...body} />}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
