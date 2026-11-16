import { cardState, clockTime, shortDateUnlessToday, type BranchCard as BranchCardData, type BranchView, type Message } from "@tangent/client";
import { ArrowUpRight, Check, ChevronDown, ChevronUp, Flag, GitMerge, Hourglass, Import, MessageSquarePlus, Pencil, TriangleAlert } from "lucide-react";
import { useF12T } from "../i18n/f12-messages";
import { memo, useId, useState, type ReactNode } from "react";
import { LEAF_ICONS, LEAF_KIND_KEYS, LEAF_TEXT } from "../leaf/leaf-meta";
import { StaleBadge, type StaleReasonsProps } from "../f8/stale-badge";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

export interface BranchCardProps {
  /** A `branch_card` message of the parent line. */
  message: Message;
  /** The branch it came from (outline), for its purpose and fork point. */
  branch?: BranchView | null;
  /** "#n" of the parent line's chat messages (fork point and decision links). */
  mainNumbers?: ReadonlyMap<string, number>;
  highlighted?: boolean;
  defaultExpanded?: boolean;
  /** The branch's leaf is the card's title row (B1, handoff §9-4; the leaf feature is on). */
  showLeaf?: boolean;
  /** Enters the branch, at one of its messages when given (evidence). */
  onOpenBranch?: (branchLineId: string, messageId?: string) => void;
  /** Highlights a message of this (the parent) line. */
  onGoToMessage?: (messageId: string) => void;
  /** F8 S12: the tree whose notes and relations may have changed this card's premise (前提已更新), and the ways to them. */
  stale?: { rootLineId: string } & Omit<StaleReasonsProps, "reasons" | "className">;
  /** F12 S6 編輯結論 (writers only; the host opens the edit dialog). */
  onEdit?: () => void;
  /** F12 S6 繼續追問: a new branch anchored on this card (writers only). */
  onFollowUp?: () => void;
  className?: string;
}

/** S6: the card's 編輯結論 and 繼續追問 (h30, touch 44). */
const ACTION_BUTTON =
  "inline-flex h-7.5 items-center justify-center gap-1.5 rounded-tg-sm border border-tg-card-border bg-tg-surface px-2.5 text-tg-xs font-medium hover:bg-tg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11";

const FOOTER_BUTTON =
  "inline-flex h-7 items-center gap-1 rounded-tg-sm px-2 text-tg-xs hover:bg-tg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11";

function Delivery({ message }: { message: Message }) {
  const t = useUiT();
  const f12 = useF12T();
  const state = cardState(message);
  if (state === "editedPending") {
    return (
      <span data-tg-card-state="editedPending" className="inline-flex h-5.5 items-center gap-1 rounded-tg-full bg-tg-primary-soft px-2 text-tg-xs font-medium text-tg-primary-text">
        <Pencil aria-hidden className="size-3" />
        {f12("card.editedPending")}
      </span>
    );
  }
  if (state === "delivered") {
    return (
      <span className="inline-flex items-center gap-1 text-tg-xs text-tg-muted">
        <Check aria-hidden className="size-3" />
        {t("card.delivered")}
      </span>
    );
  }
  return (
    <span className="inline-flex h-5.5 items-center gap-1 rounded-tg-full border border-tg-card-border bg-tg-surface px-2 text-tg-xs text-tg-muted">
      <Hourglass aria-hidden className="size-3" />
      {t("card.pending")}
    </span>
  );
}

/** F14 S4b: a card an import wrote (the branch's origin is import) says so, with when it was brought back in the source. */
function ImportedMark({ message }: { message: Message }) {
  const t = useUiT();
  const clock = clockTime(message.createdAt);
  const day = shortDateUnlessToday(message.createdAt);
  const when = clock ? [day, clock].filter(Boolean).join(" ") : "";
  return (
    <span data-tg-card-state="imported" className="inline-flex items-center gap-1 text-tg-xs text-tg-muted">
      <Import aria-hidden className="size-3" />
      <span>
        {t("card.fromImport")}
        {when && (
          <time dateTime={message.createdAt}>
            {t("message.timeSeparator")}
            {when}
          </time>
        )}
      </span>
    </span>
  );
}

function Decisions({ card, numbers, onGoToMessage }: { card: BranchCardData; numbers: ReadonlyMap<string, number> | undefined; onGoToMessage: BranchCardProps["onGoToMessage"] }) {
  const t = useUiT();
  if (card.needsDecision.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-tg bg-tg-warning-soft px-3 py-2.5">
      <span className="inline-flex items-center gap-1.5 text-tg-xs font-semibold text-tg-warning">
        <TriangleAlert aria-hidden className="size-3.5" />
        {t("card.needsDecision")}
      </span>
      {card.needsDecision.map((item, index) => {
        const number = item.mainLineMessageId ? numbers?.get(item.mainLineMessageId) : undefined;
        const mainLabel = number === undefined ? t("card.mainClaimNoRef") : t("card.mainClaim", { n: number });
        const main = (
          <>
            <span className="text-tg-xs text-tg-primary-text">{mainLabel}</span>
            <span>{item.mainLineClaim}</span>
          </>
        );
        return (
          <div key={index} className="grid grid-cols-[repeat(auto-fit,minmax(11.25rem,1fr))] gap-2 text-tg-sm">
            <div className="flex flex-col gap-0.5 rounded-tg-sm bg-tg-surface px-2.5 py-2">
              <span className="text-tg-xs text-tg-muted">{t("card.branchClaim")}</span>
              <span>{item.branchClaim}</span>
            </div>
            {item.mainLineMessageId && onGoToMessage ? (
              <button
                type="button"
                onClick={() => onGoToMessage(item.mainLineMessageId ?? "")}
                className="flex flex-col gap-0.5 rounded-tg-sm bg-tg-surface px-2.5 py-2 text-left text-tg-foreground hover:outline hover:outline-tg-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
              >
                {main}
              </button>
            ) : (
              <div className="flex flex-col gap-0.5 rounded-tg-sm bg-tg-surface px-2.5 py-2">{main}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="mb-0.5 text-tg-xs text-tg-muted">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

function Details({ card, branchLineId, onOpenBranch }: { card: BranchCardData; branchLineId: string; onOpenBranch: BranchCardProps["onOpenBranch"] }) {
  const t = useUiT();
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 text-tg-sm">
      {card.question && <Field label={t("card.question")}>{card.question}</Field>}
      {card.evidence.length > 0 && (
        <Field label={t("card.evidence")}>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {card.evidence.map((item, index) => (
              <li key={index} className="flex items-start gap-2">
                {onOpenBranch && branchLineId ? (
                  <button
                    type="button"
                    aria-label={t("card.evidenceRef", { n: index + 1 })}
                    onClick={() => onOpenBranch(branchLineId, item.messageId)}
                    className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-tg-sm px-1.5 font-tg-mono text-tg-xs text-tg-primary-text hover:bg-tg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
                  >
                    {index + 1}
                    <ArrowUpRight aria-hidden className="size-3" />
                  </button>
                ) : (
                  <span className="shrink-0 font-tg-mono text-tg-xs text-tg-muted">{index + 1}</span>
                )}
                <span>{item.note}</span>
              </li>
            ))}
          </ol>
        </Field>
      )}
      {card.impact && <Field label={t("card.impact")}>{card.impact}</Field>}
      {card.openItems.length > 0 && (
        <Field label={t("card.openItems")}>
          <ul className="m-0 list-disc pl-5">
            {card.openItems.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </Field>
      )}
      {card.excerpts.length > 0 && (
        <Field label={t("card.excerpts")}>
          <div className="flex flex-col gap-1">
            {card.excerpts.map((item, index) => (
              <code key={index} className="block rounded-tg-sm bg-tg-surface px-2.5 py-1.5 font-tg-mono text-tg-xs whitespace-pre-wrap">
                {item.text}
              </code>
            ))}
          </div>
        </Field>
      )}
    </dl>
  );
}

/**
 * A conclusion card in the parent line (A5; components.md r lg, `--tg-card`,
 * p 14): the only message with a fill and a border. Folded it shows the
 * branch's purpose, the conclusion and anything that needs a decision;
 * unfolded, every field. "The AI hears about it next turn" until a finished
 * turn carried it. Links go to the branch, its evidence and the fork point.
 */
/** The conclusion row: the card's conclusion with the conclusion flag, or the branch's leaf (its kind's icon, colour and line). */
function TitleRow({ text, leaf }: { text: string; leaf: BranchView["leaf"] | undefined }) {
  const t = useUiT();
  const Icon = leaf ? LEAF_ICONS[leaf.kind] : Flag;
  return (
    <div className="flex gap-2.5" {...(leaf ? { "data-tg-leaf": leaf.kind } : {})}>
      <Icon aria-hidden className={cx("mt-1 size-4 shrink-0", leaf ? LEAF_TEXT[leaf.kind] : "text-tg-leaf-conclusion")} />
      <p className="m-0 font-tg-serif text-tg-reading leading-[1.6] font-semibold text-tg-foreground-strong">
        {leaf && <span className="sr-only">{t("leaf.kindPrefix", { kind: t(LEAF_KIND_KEYS[leaf.kind]) })}</span>}
        {leaf ? leaf.line : text}
      </p>
    </div>
  );
}

function BranchCardView({ message, branch, mainNumbers, highlighted = false, defaultExpanded = false, showLeaf = false, onOpenBranch, onGoToMessage, stale, onEdit, onFollowUp, className }: BranchCardProps) {
  const t = useUiT();
  const f12 = useF12T();
  const detailsId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const card = message.meta.card;
  const branchLineId = message.meta.branchLineId ?? branch?.lineId ?? "";
  const forkNumber = branch ? mainNumbers?.get(branch.anchorMessageId) : undefined;
  return (
    <section
      aria-label={t("message.card")}
      className={cx(
        "@container/tg-card flex flex-col overflow-hidden rounded-tg-lg border border-tg-card-border bg-tg-card font-tg-sans outline-3 outline-transparent transition-[outline-color] duration-(--tg-duration-normal)",
        highlighted && "outline-tg-highlight",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-tg-card-border px-3.5 py-2.5">
        <GitMerge aria-hidden className="size-4 shrink-0 text-tg-branch-merged" />
        <span className="text-tg-xs font-semibold text-tg-branch-merged">{t("message.card")}</span>
        {branch && <span className="min-w-0 flex-[1_1_10rem] truncate text-tg-sm text-tg-foreground">{branch.purpose}</span>}
        {branch && stale && <StaleBadge {...stale} branch={branch} />}
        {branch?.origin === "import" && cardState(message) === "delivered" ? <ImportedMark message={message} /> : <Delivery message={message} />}
      </header>
      <div className="flex flex-col gap-3 px-3.5 pt-3.5 pb-1">
        <TitleRow text={card?.conclusion || message.content} leaf={showLeaf ? branch?.leaf : undefined} />
        {/* B17: the leaf the user wrote stays when the card is edited; the card's own conclusion then shows under it. */}
        {showLeaf && branch?.leaf && card && card.conclusion.trim() !== branch.leaf.line.trim() && (
          <p data-tg-card-conclusion="" className="m-0 flex gap-2 text-tg-sm text-tg-foreground">
            <span className="shrink-0 text-tg-muted">{t("card.conclusion")}</span>
            <span className="min-w-0">{card.conclusion}</span>
          </p>
        )}
        {card && <Decisions card={card} numbers={mainNumbers} onGoToMessage={onGoToMessage} />}
        {card && expanded && (
          <div id={detailsId}>
            <Details card={card} branchLineId={branchLineId} onOpenBranch={onOpenBranch} />
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-1 px-2 pt-1.5 pb-2">
        {card && (
          <button type="button" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setExpanded(!expanded)} className={cx(FOOTER_BUTTON, "text-tg-foreground")}>
            {expanded ? <ChevronUp aria-hidden className="size-3" /> : <ChevronDown aria-hidden className="size-3" />}
            {expanded ? t("card.collapse") : t("card.expand")}
          </button>
        )}
        {branch && forkNumber !== undefined && onGoToMessage && (
          <button type="button" onClick={() => onGoToMessage(branch.anchorMessageId)} className={cx(FOOTER_BUTTON, "text-tg-muted")}>
            {t("card.forkPoint", { n: forkNumber })}
          </button>
        )}
        {branchLineId && onOpenBranch && (
          <button type="button" onClick={() => onOpenBranch(branchLineId, undefined)} className={cx(FOOTER_BUTTON, "text-tg-branch-merged")}>
            {t("card.openBranch")}
            <ArrowUpRight aria-hidden className="size-3" />
          </button>
        )}
        {/* F12 S6: two secondary buttons on the right; narrow cards put them on their own row, two equal columns. */}
        {(onEdit || onFollowUp) && (
          <span className="ml-auto flex gap-1.5 @max-[30rem]/tg-card:grid @max-[30rem]/tg-card:w-full @max-[30rem]/tg-card:grid-cols-2 @max-[30rem]/tg-card:gap-2">
            {onEdit && (
              <button type="button" onClick={onEdit} className={cx(ACTION_BUTTON, "text-tg-foreground")}>
                <Pencil aria-hidden className="size-3.5" />
                {f12("card.edit")}
              </button>
            )}
            {onFollowUp && (
              <button type="button" onClick={onFollowUp} className={cx(ACTION_BUTTON, "text-tg-primary-text")}>
                <MessageSquarePlus aria-hidden className="size-3.5" />
                {f12("card.followUp")}
              </button>
            )}
          </span>
        )}
      </footer>
    </section>
  );
}

export const BranchCard = memo(BranchCardView);
