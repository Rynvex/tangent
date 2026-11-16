import type { BranchPack } from "@tangent/client";
import { formatTokens } from "../components/usage-meter";
import { useUiT } from "../provider";

/**
 * What the branch's background holds (A4 "背景展開"): the counts the server
 * recorded when it built the pack, and the exact text the model receives.
 */
export function BranchPackPanel({ pack, id }: { pack: BranchPack; id: string }) {
  const t = useUiT();
  const rows = [
    { key: "recent", show: pack.recent.length > 0, label: t("branchBar.packRecent", { count: pack.recent.length }) },
    { key: "summary", show: pack.summaryUsed, label: t("branchBar.packSummary") },
    { key: "condensed", show: pack.condensedMessages > 0, label: t("branchBar.packCondensed", { count: pack.condensedMessages }) },
    { key: "later", show: pack.laterIncluded, label: t("branchBar.packLater", { count: pack.laterMessages }) },
    { key: "excerpt", show: pack.excerpt !== "", label: t("branchBar.packExcerpt") },
  ].filter((row) => row.show);
  return (
    <div id={id} className="ml-1 flex flex-col gap-2 rounded-tg-sm border border-tg-border bg-tg-surface px-3 py-2.5 text-tg-xs">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-tg-foreground">
        {rows.map((row) => (
          <li key={row.key}>{row.label}</li>
        ))}
      </ul>
      <details className="text-tg-muted">
        <summary className="cursor-pointer rounded-tg-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
          {t("branchBar.packShow")} <span className="font-tg-mono">{t("usage.tokens", { count: formatTokens(pack.tokenEstimate) })}</span>
        </summary>
        <pre tabIndex={0} className="m-0 mt-2 max-h-60 overflow-auto rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 font-tg-sans text-tg-xs whitespace-pre-wrap text-tg-foreground">
          {pack.rendered}
        </pre>
      </details>
    </div>
  );
}
