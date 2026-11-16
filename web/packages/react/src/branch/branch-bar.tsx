import { asideDaysLeft, chatNumbers, promoteBlock, type BranchPack, type BranchStatus, type BranchView, type Message } from "@tangent/client";
import { ArrowLeft, ChevronDown, ChevronRight, CornerDownRight, ExternalLink, GitMerge, Hourglass, NotebookPen, SquareParking } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "../components/button";
import { formatTokens } from "../components/usage-meter";
import { KIND_ICONS, KIND_KEYS } from "../conversation/branch-suggestions";
import { branchStatusKey, isAsideLeaf } from "../conversation/aside-leaf";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useP1T } from "../i18n/p1-messages";
import { useOptionalShortcutText } from "../shortcuts/shortcuts-provider";
import { BranchPackPanel } from "./branch-pack-panel";
import { ForkPeek } from "./fork-peek";

/** The status dot's colour; the label stays in the muted text colour, which keeps 4.5:1 on the bar's tint in every theme. */
const STATUS_DOT: Record<BranchStatus, string> = {
  open: "bg-tg-branch-open",
  merged: "bg-tg-branch-merged",
  discarded: "bg-tg-branch-discarded",
  promoted: "bg-tg-branch-promoted",
};

export interface BranchBarProps {
  branch: BranchView;
  /** From `GET /branch`; the background row appears once it is loaded. */
  pack?: BranchPack | null;
  /** The parent line's messages (fork label and peek). */
  parentMessages: readonly Message[];
  /** Hides every ending action (read-only identity). */
  readOnly?: boolean;
  /** For the aside's retention countdown; defaults to now. */
  now?: number;
  onBack: () => void;
  /** Switches to the parent line and highlights the fork point. */
  onGoToFork: () => void;
  onBringBack?: () => void;
  onDiscard?: () => void;
  /** Shown only for an open branch directly on the main line. */
  onPromote?: () => void;
  /** An aside's answer into the notes (notes feature). */
  onKeepAsideAsNote?: () => void;
  /** An aside's answer into the parking lot (parking feature, P1). */
  onParkAside?: () => void;
  /** The ended branch's leaf and its editing (`BranchLeaf`, the leaf feature); shown once the branch has ended. */
  leaf?: ReactNode;
  /** 獨立成新對話 (the spinoff feature, B2); offered while the branch is open. */
  onSpinoff?: () => void;
  /** A conversation was spun off from this branch (its marker's `spunOffTo`): 「已獨立 →」. */
  spunOffTo?: { title: string; available: boolean } | null;
  onOpenSpinoff?: () => void;
  /** The tree-balance hint (`RebalanceHint`, B4), under the actions; no popup. */
  hint?: ReactNode;
  className?: string;
}

function SmallAction({ icon, children, onClick }: { icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return (
    <Button size="sm" icon={icon} onClick={onClick}>
      {children}
    </Button>
  );
}

function AsideRow({ branch, now, readOnly, onKeep, onPark }: { branch: BranchView; now: number; readOnly: boolean; onKeep?: (() => void) | undefined; onPark?: (() => void) | undefined }) {
  const t = useUiT();
  const canKeep = !readOnly && (onKeep || onPark);
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-1">
      <span className="inline-flex h-6 items-center gap-1 rounded-tg-full bg-tg-accent px-2 text-tg-xs text-tg-muted">
        <Hourglass aria-hidden className="size-3" />
        {branch.keptAt ? t("branchBar.asideKept") : t("branchBar.asideExpires", { days: asideDaysLeft(branch.closedAt, now) })}
      </span>
      {canKeep && <span className="text-tg-xs text-tg-muted">{t("branchBar.asideKeep")}</span>}
      {!readOnly && onKeep && (
        <SmallAction icon={<NotebookPen aria-hidden className="size-3" />} onClick={onKeep}>
          {t("asideNote.save")}
        </SmallAction>
      )}
      {!readOnly && onPark && (
        <SmallAction icon={<SquareParking aria-hidden className="size-3" />} onClick={onPark}>
          {t("composer.park")}
        </SmallAction>
      )}
    </div>
  );
}

/** 「已獨立 →」: a conversation was spun off from this branch. */
function SpunOff({ title, onOpen, gone }: { title: string; onOpen?: (() => void) | undefined; gone: boolean }) {
  const t = useUiT();
  // B8.2: a deleted conversation is named, not linked.
  const label = gone ? t("marker.spunOffGone", { title }) : t("marker.spunOffLink", { title });
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex items-center gap-1 self-start pl-1 text-tg-xs text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
    >
      <ExternalLink aria-hidden className="size-3" />
      {label}
    </button>
  ) : (
    <span className="pl-1 text-tg-xs text-tg-muted">{label}</span>
  );
}

function Actions({ branch, onBringBack, onDiscard, onPromote, onSpinoff }: Pick<BranchBarProps, "branch" | "onBringBack" | "onDiscard" | "onPromote" | "onSpinoff">) {
  const p1 = useP1T();
  const t = useUiT();
  const keys = useOptionalShortcutText("branch.bringBack");
  const isAside = branch.kind === "aside";
  const canPromote = !isAside && promoteBlock(branch) === null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-1">
      {!isAside && onBringBack && (
        <Button variant="primary" icon={<GitMerge aria-hidden className="size-3.5" />} title={keys ? t("branchBar.withKeys", { label: t("branchBar.bringBack"), keys }) : undefined} onClick={onBringBack}>
          {t("branchBar.bringBack")}
        </Button>
      )}
      {onDiscard && <Button onClick={onDiscard}>{t("branchBar.discard")}</Button>}
      {canPromote && onPromote && <Button onClick={onPromote}>{t("branchBar.promote")}</Button>}
      {!isAside && onSpinoff && (
        <Button icon={<ExternalLink aria-hidden className="size-3.5" />} onClick={onSpinoff}>
          {p1("branchBar.spinoff")}
        </Button>
      )}
    </div>
  );
}

/**
 * The bar on top of a branch (A4; components.md min h 88, p 10/14): the way
 * back, kind and status, the purpose, where it forked (link and peek), the
 * selected text, the background (expandable, with its token estimate), an
 * aside's retention and ways to keep it, and the endings while it is open.
 */
export function BranchBar(props: BranchBarProps) {
  const { branch, pack, parentMessages, readOnly = false, now = Date.now(), onBack, onGoToFork, className } = props;
  const t = useUiT();
  const packId = useId();
  const [packOpen, setPackOpen] = useState(false);
  const isParentMain = branch.parentLineId === branch.rootLineId;
  const anchorNumber = chatNumbers(parentMessages).get(branch.anchorMessageId);
  const forkLabel =
    anchorNumber === undefined ? t("branch.forkFromMessage") : isParentMain ? t("branch.forkFromMain", { n: anchorNumber }) : t("branch.forkFromBranch", { n: anchorNumber });
  const open = branch.status === "open";
  // F11 §1: an aside is a one-turn leaf; its bar says so in words and in a soft dashed frame.
  const leaf = isAsideLeaf(branch);
  const answering = leaf && branchStatusKey(branch) === "branch.asideAnswering";
  return (
    <section
      aria-label={t("branchBar.label")}
      data-tg-leaf-bar={leaf ? "" : undefined}
      className={cx("flex min-h-22 shrink-0 flex-col gap-2 border-b border-tg-border bg-tg-primary-soft px-3.5 py-2.5", leaf && "outline-1 -outline-offset-4 outline-tg-border-input outline-dashed", className)}
    >
      <div className="flex items-start gap-2">
        <Button size="sm" icon={<ArrowLeft aria-hidden className="size-3.5" />} onClick={onBack} className="shrink-0">
          {isParentMain ? t("branchBar.backMain") : t("branchBar.backParent")}
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-tg-xs">
            <span className="inline-flex items-center gap-1 font-semibold text-tg-primary-text [&_svg]:size-3.5">
              {KIND_ICONS[branch.kind]}
              {t(KIND_KEYS[branch.kind])}
            </span>
            {leaf && (
              <span data-tg-leaf-hint="" className="inline-flex items-center rounded-tg-full border border-dashed border-tg-border-input px-2 text-tg-foreground">
                {t("branch.asideLeafHint")}
              </span>
            )}
            {/* An aside's status is its leaf hint above, except 回答中 while it answers. */}
            {(!leaf || answering) && (
              <span className="inline-flex items-center gap-1 text-tg-foreground">
                <span aria-hidden className={cx("size-1.5 rounded-tg-full", STATUS_DOT[branch.status])} />
                {t(branchStatusKey(branch))}
              </span>
            )}
            <span className="text-tg-muted">{t("branchBar.youAreHere")}</span>
            {open && branch.draftStatus === "drafting" && <span className="text-tg-muted">{t("branchBar.drafting")}</span>}
            {open && branch.draftStatus === "ready" && <span className="font-medium text-tg-primary-text">{t("branchBar.draftReady")}</span>}
          </div>
          <h2 className="m-0 text-tg-md font-semibold break-words text-tg-foreground-strong">{branch.purpose}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-tg-xs text-tg-muted">
            <button
              type="button"
              onClick={onGoToFork}
              className="inline-flex items-center gap-1 text-tg-primary-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
            >
              <CornerDownRight aria-hidden className="size-3" />
              {forkLabel}
            </button>
            <ForkPeek messages={parentMessages} anchorMessageId={branch.anchorMessageId} onGo={onGoToFork} />
            {branch.excerpt && <span className="max-w-70 min-w-0 truncate">{t("branchBar.selection", { text: branch.excerpt })}</span>}
            {pack && (
              <button
                type="button"
                aria-expanded={packOpen}
                aria-controls={packOpen ? packId : undefined}
                onClick={() => setPackOpen(!packOpen)}
                className="inline-flex items-center gap-0.5 font-tg-mono text-tg-muted hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
              >
                {packOpen ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
                {t("branchBar.pack", { tokens: formatTokens(pack.tokenEstimate) })}
              </button>
            )}
          </div>
        </div>
      </div>
      {pack && packOpen && <BranchPackPanel pack={pack} id={packId} />}
      {props.spunOffTo && (
        <SpunOff title={props.spunOffTo.title} onOpen={props.spunOffTo.available ? props.onOpenSpinoff : undefined} gone={!props.spunOffTo.available} />
      )}
      {!open && props.leaf}
      {branch.kind === "aside" && <AsideRow branch={branch} now={now} readOnly={readOnly} onKeep={props.onKeepAsideAsNote} onPark={props.onParkAside} />}
      {open && !readOnly && <Actions branch={branch} onBringBack={props.onBringBack} onDiscard={props.onDiscard} onPromote={props.onPromote} onSpinoff={props.onSpinoff} />}
      {open && !readOnly && props.hint}
    </section>
  );
}
