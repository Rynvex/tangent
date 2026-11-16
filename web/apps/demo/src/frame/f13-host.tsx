/**
 * F13 S4 in the demo frame: the imported banner above the transcript and the
 * decompose panel (the right 400px column on desktop, standing in for the
 * side panel while it is open; the phone's tall sheet from 96px down). Both
 * load on first use; the panel's plan is one snapshot per opening.
 */
import { filterSuggestedTags, isFeatureOn, knownTagCounts, type ExtractBranchResult } from "@tangent/client";
import {
  DecomposePanel,
  IconButton,
  countSuggestions,
  useBranches,
  useCapabilities,
  useChapters,
  useDecompose,
  useLine,
  useLineOrganization,
  useLines,
  useMessages,
  useReadOnly,
} from "@tangent/react";
import { FileCheck, RotateCcw, Sparkles, X } from "lucide-react";
import { useMemo } from "react";
import { cx } from "./cx";
import { useF13ShellT } from "./f13-shell-messages";
import { useSticky } from "./hooks";

export interface ImportedBannerProps {
  lineId: string;
  /** Messages the import wrote to the main line. */
  messageCount: number;
  /** F14: an assembly from several conversations ("已匯入 m 則・k 項拆解建議"). */
  assembled?: boolean;
  panelOpen: boolean;
  narrow: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** F14.1: 復原這次匯入, while the import can still be undone (the same as the toast's). */
  onUndo?: () => void;
  /** Its label (the frame's words, as the toast's). */
  undoLabel?: string;
}

/** 已匯入 N 則訊息・有 K 項拆解與支線建議 (only after an import; closed, it does not come back). */
export function ImportedBanner({ lineId, messageCount, assembled = false, panelOpen, narrow, onOpen, onClose, onUndo, undoLabel }: ImportedBannerProps) {
  const s = useF13ShellT();
  const plan = useDecompose(lineId);
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const line = useLine(lineId);
  const on = (name: Parameters<typeof isFeatureOn>[1]) => isFeatureOn(capabilities.data, name);
  const tags = plan.data ? filterSuggestedTags(plan.data.suggestedTags, line.data?.title ?? "") : [];
  const count = plan.data
    ? countSuggestions(plan.data, tags, { write: !readOnly, fold: on("fold"), chapters: on("chapters"), parking: on("parking"), relations: on("relations"), spinoff: on("spinoff"), tags: true })
    : null;
  const text = plan.isPending
    ? s("banner.looking", { n: messageCount })
    : count
      ? assembled
        ? s("banner.assembled", { m: messageCount, k: count })
        : s("banner.imported", { n: messageCount, k: count })
      : s("banner.importedNone", { n: messageCount });
  return (
    <div data-tg-imported-banner="" className={cx("flex min-h-11 shrink-0 flex-wrap items-center gap-2.5 border-b border-tg-border bg-tg-suggestion-soft py-1.5 text-tg-sm text-tg-foreground", narrow ? "px-4" : "px-8")}>
      <FileCheck aria-hidden className="size-4 shrink-0 text-tg-suggestion" />
      <span role="status" className="min-w-0 flex-1">
        {text}
      </span>
      {Boolean(count) && (
        <button
          type="button"
          aria-pressed={panelOpen}
          onClick={onOpen}
          className={cx(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-tg-sm px-2.5 text-tg-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-10",
            panelOpen ? "bg-tg-primary-soft text-tg-primary-text" : "text-tg-primary-text hover:bg-tg-accent",
          )}
        >
          <Sparkles aria-hidden className="size-3.5" />
          {panelOpen ? s("banner.opened") : narrow ? s("banner.open") : s("banner.openDesk")}
        </button>
      )}
      {onUndo && undoLabel && (
        <button
          type="button"
          onClick={onUndo}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-tg-sm px-2.5 text-tg-xs font-medium text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-10"
        >
          <RotateCcw aria-hidden className="size-3.5" />
          {undoLabel}
        </button>
      )}
      <IconButton label={s("banner.close")} icon={<X />} size="sm" onClick={onClose} />
    </div>
  );
}

export interface DecomposeHostProps {
  lineId: string;
  variant: "side" | "sheet";
  onClose: () => void;
  onHighlight: (messageIds: readonly string[]) => void;
  navigate: (lineId: string, messageId?: string) => void;
  onSpinoff: (lineId: string, atMessageId: string) => void;
  onExtracted: (result: ExtractBranchResult) => void;
}

/** The panel fed from the cache: the line, its messages, the tree's outline, chapter starts and the tenant's tags. */
export function DecomposeHost({ lineId, variant, onClose, onHighlight, navigate, onSpinoff, onExtracted }: DecomposeHostProps) {
  // Sticky: an extract from the panel resets these queries; the panel (and what it applied) must stay.
  const line = useSticky(useLine(lineId).data);
  const root = line ? (line.conversationBranch?.rootLineId ?? line.id) : null;
  const rootLine = useLine(root);
  const messages = useSticky(useMessages(lineId).data);
  const outline = useSticky(useBranches(root, true).data);
  const capabilities = useCapabilities();
  const chapters = useChapters(root, lineId, isFeatureOn(capabilities.data, "chapters"));
  const lines = useLines();
  const cuts = useMemo(() => new Set((chapters.data?.chapters ?? []).slice(1).map((chapter) => chapter.startMessageId)), [chapters.data]);
  // Tags of the tenant's other conversations stay among the suggestions even when they look like fragments; since B18.1
  // the tenant's (as the server's own cleaning uses them), the loaded conversations until they are read.
  const organization = useLineOrganization().data;
  const tenantTags = useMemo(() => knownTagCounts(organization, (lines.data?.lines ?? []).filter((item) => item.id !== root)).map((item) => item.tag), [organization, lines.data, root]);
  if (!line || !messages) return null;
  const panel = (
    <DecomposePanel
      line={line}
      rootLine={rootLine.data}
      messages={messages.messages}
      branches={outline?.branches ?? []}
      cutMessageIds={cuts}
      tenantTags={tenantTags}
      variant={variant}
      onClose={onClose}
      onHighlight={onHighlight}
      onNavigate={navigate}
      onSpinoff={(atMessageId) => onSpinoff(lineId, atMessageId)}
      onExtracted={onExtracted}
    />
  );
  if (variant === "side") return panel;
  // The phone's panel: from 96px down over the conversation, which stays visible above it.
  return <div className="absolute inset-x-0 top-24 bottom-0 z-30 overflow-hidden rounded-t-[1.125rem] bg-tg-background shadow-tg-overlay">{panel}</div>;
}
