import { estimatePack, type BranchKind, type BranchPack, type Message } from "@tangent/client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatTokens } from "../components/usage-meter";
import { useBranchPreview } from "../data/branch-queries";
import type { MessageKey } from "../i18n";
import { useUiT } from "../provider";

/** The server's preview waits until the purpose stops changing. */
const PREVIEW_DEBOUNCE_MS = 350;

const ROW_KEYS: Record<"purpose" | "excerpt" | "recent" | "later", MessageKey> = {
  purpose: "branch.pack.purpose",
  excerpt: "branch.pack.excerpt",
  recent: "branch.pack.recent",
  later: "branch.pack.later",
};

export interface PackEstimateProps {
  /** The parent line. */
  lineId: string;
  kind: BranchKind;
  messages: readonly Message[];
  anchorMessageId: string;
  purpose: string;
  excerpt: string;
  includeLater: boolean;
}

interface Row {
  key: string;
  label: string;
  tokens?: number;
}

function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** What the server says the pack holds: the parts it quoted or condensed (no per-part tokens). */
function serverRows(pack: BranchPack, t: ReturnType<typeof useUiT>): Row[] {
  return [
    { key: "purpose", label: t(ROW_KEYS.purpose) },
    ...(pack.excerpt ? [{ key: "excerpt", label: t(ROW_KEYS.excerpt) }] : []),
    ...(pack.summaryUsed ? [{ key: "summary", label: t("branch.packServer.summary") }] : []),
    ...(pack.condensedMessages > 0 ? [{ key: "condensed", label: t("branch.packServer.condensed", { count: pack.condensedMessages }) }] : []),
    { key: "recent", label: t(ROW_KEYS.recent, { count: pack.recent.length }) },
    ...(pack.laterIncluded && pack.laterMessages > 0 ? [{ key: "later", label: t(ROW_KEYS.later, { count: pack.laterMessages }) }] : []),
    { key: "budget", label: t("branch.packServer.budget", { tokens: formatTokens(pack.tokenBudget) }) },
  ];
}

/**
 * "What the background brings" (A3): the server's preview of the pack
 * (B5 `POST /branches/preview`, again whenever the purpose settles), or — while it
 * loads, or from a server without the route — a client-side estimate,
 * labelled as one.
 */
export function PackEstimate({ lineId, kind, purpose, ...rest }: PackEstimateProps) {
  const t = useUiT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const settledPurpose = useSettled(purpose.trim(), PREVIEW_DEBOUNCE_MS);
  // The server previews before a purpose is typed too (B5); the purpose only changes the pack's text.
  const input = {
    anchorMessageId: rest.anchorMessageId,
    kind,
    ...(settledPurpose ? { purpose: settledPurpose } : {}),
    ...(rest.excerpt ? { excerpt: rest.excerpt } : {}),
    ...(rest.includeLater ? { includeLater: true } : {}),
  };
  const preview = useBranchPreview(lineId, input);
  const server = preview.data ?? null;
  const estimate = estimatePack({ ...rest, purpose });
  const rows: Row[] = server ? serverRows(server.pack, t) : estimate.rows.map((row) => ({ key: row.key, label: t(ROW_KEYS[row.key], { count: row.count }), tokens: row.tokens }));
  const total = server ? server.tokenEstimate : estimate.total;
  return (
    <div className="rounded-tg-sm border border-tg-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="flex min-h-10 w-full items-center gap-2 rounded-tg-sm px-3 text-left text-tg-sm text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
      >
        {open ? <ChevronDown aria-hidden className="size-3 text-tg-muted" /> : <ChevronRight aria-hidden className="size-3 text-tg-muted" />}
        <span className="flex-1">{t("branch.packTitle")}</span>
        <span className="font-tg-mono text-tg-xs text-tg-muted">{t("branch.packTotal", { tokens: formatTokens(total) })}</span>
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-1 px-3 pb-2.5 pl-8 text-tg-xs text-tg-muted">
          {rows.map((row) => (
            <span key={row.key} className="flex justify-between gap-3">
              {row.label}
              {row.tokens !== undefined && <span className="font-tg-mono">{formatTokens(row.tokens)}</span>}
            </span>
          ))}
          <span className="text-tg-subtle">{t(server ? "branch.packServer.note" : "branch.packEstimate")}</span>
        </div>
      )}
    </div>
  );
}
