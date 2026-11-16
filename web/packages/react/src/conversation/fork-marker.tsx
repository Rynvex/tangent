import { branchTitle, type BranchStatus, type BranchView } from "@tangent/client";
import { ChevronDown, ChevronUp, GitBranch, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { isAsideLeaf } from "./aside-leaf";
import { KIND_ICONS } from "./branch-suggestions";
import { forkSummary, STATUS_KEYS } from "./models";

const DOT: Record<BranchStatus, string> = {
  open: "bg-tg-branch-open",
  merged: "bg-tg-branch-merged",
  discarded: "bg-tg-branch-discarded",
  promoted: "bg-tg-branch-promoted",
};

const TEXT: Record<BranchStatus, string> = {
  open: "text-tg-branch-open",
  merged: "text-tg-branch-merged",
  discarded: "text-tg-branch-discarded",
  promoted: "text-tg-branch-promoted",
};

export interface ForkMarkerProps {
  /** The branches that fork from this message (`forksByAnchor`). */
  branches: readonly BranchView[];
  /** Enters a branch; with it the pill opens an inline list of the branches (A4), without it the pill only informs. */
  onSelect?: (branch: BranchView) => void;
  defaultOpen?: boolean;
  /** F12 S1: an aside's row opens it in place under the message (or closes it) instead of entering it. */
  onToggleAside?: (branch: BranchView) => void;
  /** The asides open in place now (their rows read 原地展開中). */
  inlineOpen?: ReadonlySet<string>;
  /** Branches whose premise changed (B17: a follow-up of an edited card), marked in their rows. */
  staleIds?: ReadonlySet<string>;
  /** Under a conclusion card: 「從這張結論卡追問」 in the summary. */
  fromCard?: boolean;
  className?: string;
}

const NONE: ReadonlySet<string> = new Set();

/** An aside's row when it can open in place: 原地展開中 or 已回答・在這裡展開 (an answer still coming keeps its own status). */
function inlineStatus(branch: BranchView, open: boolean, t: ReturnType<typeof useUiT>): string | null {
  if (open) return t("fork.inlineOpen");
  return branch.status !== "open" ? t("fork.inlineClosed") : null;
}

function ForkRow({ branch, onSelect, onToggleAside, open, stale }: { branch: BranchView; onSelect: (branch: BranchView) => void; onToggleAside: ((branch: BranchView) => void) | undefined; open: boolean; stale: boolean }) {
  const t = useUiT();
  const inline = onToggleAside && isAsideLeaf(branch);
  const status = inline ? inlineStatus(branch, open, t) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => (inline ? onToggleAside(branch) : onSelect(branch))}
        {...(inline ? { "aria-expanded": open } : {})}
        data-tg-fork-row={branch.lineId}
        className={cx(
          "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 rounded-tg-sm px-2.5 py-2 text-left text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11",
          open && "bg-tg-primary-soft",
        )}
      >
        <span aria-hidden className={cx("flex [&_svg]:size-3.5", TEXT[branch.status])}>
          {KIND_ICONS[branch.kind]}
        </span>
        <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-tg-sm font-medium", branch.status === "discarded" && !isAsideLeaf(branch) && "text-tg-muted")}>
          {stale && (
            <span role="img" aria-label={t("fork.stale")} title={t("fork.stale")} className="inline-flex size-4 shrink-0 items-center justify-center rounded-tg-full border border-tg-warning bg-tg-warning-soft">
              <TriangleAlert aria-hidden className="size-2.5 text-tg-warning" />
            </span>
          )}
          <span className="truncate">{branchTitle(branch, t)}</span>
        </span>
        {/* F11 §1: an aside is a one-turn leaf, not a branch left unbrought. */}
        <span data-tg-fork-status="" className={cx("inline-flex items-center gap-1 text-tg-xs whitespace-nowrap", status && open ? "font-medium text-tg-primary-text" : isAsideLeaf(branch) ? "text-tg-muted" : TEXT[branch.status])}>
          {status ?? (isAsideLeaf(branch) ? t("fork.asideLeaf") : t(STATUS_KEYS[branch.status]))}
          {status && (open ? <ChevronUp aria-hidden className="size-3" /> : <ChevronDown aria-hidden className="size-3" />)}
        </span>
        {branch.conclusionLine && <span className="col-start-2 col-end-4 truncate text-tg-xs text-tg-muted">{branch.conclusionLine}</span>}
        {branch.status === "open" && branch.unread > 0 && (
          <span className="col-start-2 col-end-4 text-tg-xs font-semibold text-tg-primary-text">{t("fork.unread", { count: branch.unread })}</span>
        )}
      </button>
    </li>
  );
}

/**
 * The fork pill after a message (handoff §9-3; components.md h28, full
 * radius): count, one status dot per branch and a short summary. With
 * `onSelect` it is a disclosure that opens the inline list of the branches
 * (kind, purpose, status, conclusion, unread); a row enters that branch.
 */
export function ForkMarker({ branches, onSelect, defaultOpen = false, onToggleAside, inlineOpen = NONE, staleIds = NONE, fromCard = false, className }: ForkMarkerProps) {
  const t = useUiT();
  const listId = useId();
  const [open, setOpen] = useState(defaultOpen);
  if (branches.length === 0) return null;
  const counted = forkSummary(branches, t);
  const summary = fromCard ? { ...counted, text: [t("fork.fromCard"), counted.text].filter(Boolean).join("・") } : counted;
  const count = t("fork.count", { count: summary.count });
  const content = (
    <>
      <GitBranch aria-hidden className="size-3.5 shrink-0 text-tg-branch-open" />
      <span className="font-medium text-tg-foreground">{count}</span>
      <span aria-hidden className="inline-flex gap-0.75">
        {summary.statuses.map((status, index) => (
          <span key={index} data-tg-fork-dot="" className={cx("size-1.5 rounded-tg-full", DOT[status])} />
        ))}
      </span>
      <span className="min-w-0 truncate">{summary.text}</span>
    </>
  );
  const classes = cx(
    "inline-flex h-7 max-w-full items-center gap-2 self-start rounded-tg-full border border-tg-border bg-tg-surface pr-2.5 pl-1.5 font-tg-sans text-tg-xs text-tg-muted",
    className,
  );
  if (!onSelect) {
    return (
      <span data-tg-fork="" className={classes}>
        {content}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 font-tg-sans">
      <button
        type="button"
        data-tg-fork=""
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t("fork.label", { summary: `${count}・${summary.text}` })}
        onClick={() => setOpen(!open)}
        className={cx(classes, "hover:border-tg-primary hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11")}
      >
        {content}
        {open ? <ChevronUp aria-hidden className="size-3 shrink-0" /> : <ChevronDown aria-hidden className="size-3 shrink-0" />}
      </button>
      {open && (
        <ul id={listId} aria-label={t("fork.list")} className="m-0 flex list-none flex-col gap-0.5 rounded-tg border border-tg-border bg-tg-surface p-1">
          {branches.map((branch) => (
            <ForkRow key={branch.lineId} branch={branch} onSelect={onSelect} onToggleAside={onToggleAside} open={inlineOpen.has(branch.lineId)} stale={staleIds.has(branch.lineId)} />
          ))}
        </ul>
      )}
    </div>
  );
}
