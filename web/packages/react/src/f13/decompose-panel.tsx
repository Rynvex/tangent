import { chatNumbers, filterSuggestedTags, isFeatureOn, type AttachLineResult, type BranchView, type FeatureName, type DetourRange, type ExtractBranchResult, type LineView, type Message, type RelatedLine } from "@tangent/client";
import { Sparkles, X } from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { describeError } from "../conversation/error-text";
import { useDecompose } from "../data/b18-hooks";
import { useCapabilities } from "../data/queries";
import { useReadOnly } from "../data/live-hooks";
import { useF13T } from "../i18n/f13-messages";
import { cx } from "../lib/cx";
import { useTangent, useUiT } from "../provider";
import { CardSkeletons, PENDING, type ItemState } from "./decompose-cards";
import { countSuggestions, detourAvailable, rangeMessageIds, spinoffCandidate, visibleCards, type DecomposeAbilities } from "./decompose-model";
import { ChaptersCard, DetourCard, TagsSeedsCard, type ItemStore } from "./decompose-sections";
import { ATTACH_OTHER_KEY, attachFocusTarget, attachKey, RelatedCard } from "./related-card";

/** The extract dialog loads the first time a detour is moved. */
const ExtractBranchDialog = lazy(() => import("./extract-branch-dialog"));
/** The attach dialog (F15) loads the first time a conversation is attached. */
const AttachLineDialog = lazy(() => import("./attach-line-dialog"));

export interface DecomposePanelProps {
  /** The line on screen (its plan is shown). */
  line: LineView;
  /** Its main line (tags live there); the same as `line` on a main line. */
  rootLine: LineView | undefined;
  messages: readonly Message[];
  /** The tree's outline. */
  branches: readonly BranchView[];
  /** Messages that start a chapter (the extract dialog's end stops before them). */
  cutMessageIds?: ReadonlySet<string>;
  /** Tags of the tenant's other conversations (kept among the suggestions even when short). */
  tenantTags?: readonly string[];
  /** `side`: the right 400px column; `sheet`: the phone's panel from 96px down. */
  variant?: "side" | "sheet";
  onClose: () => void;
  /** Messages to outline in the transcript ([] clears it). */
  onHighlight: (messageIds: readonly string[]) => void;
  onNavigate: (lineId: string, messageId?: string) => void;
  /** 從 #n 獨立成新對話…: the host opens its spinoff dialog at that message. */
  onSpinoff?: (atMessageId: string) => void;
  /** Called after a detour moved (the host may say so). */
  onExtracted?: (result: ExtractBranchResult) => void;
  /** Called after another conversation was attached as a branch (F15; the host may say so). */
  onAttached?: (result: AttachLineResult) => void;
}

/**
 * F13 S4 拆解與整理建議 (w400 beside the transcript, or the phone's tall
 * sheet): the server's plan (made without a model) in four cards that apply
 * one by one — detours (move with a card, fold, skip), chapter breaks, tags
 * and parked to-dos, related conversations and a split. Each action needs
 * its feature and write access; a viewer reads only. The plan is a snapshot
 * for this opening; what was applied is remembered while the panel stays.
 */
export function DecomposePanel({ line, rootLine, messages, branches, cutMessageIds, tenantTags = [], variant = "side", onClose, onHighlight, onNavigate, onSpinoff, onExtracted, onAttached }: DecomposePanelProps) {
  const t = useF13T();
  const ui = useUiT();
  const { hostErrorText } = useTangent();
  const readOnly = useReadOnly();
  const capabilities = useCapabilities();
  const plan = useDecompose(line.id);
  const [items, setItems] = useState<Readonly<Record<string, ItemState>>>({});
  const [extracting, setExtracting] = useState<DetourRange | null>(null);
  // F15: the related line being attached, or null for one picked from the list; undefined while no dialog is open.
  const [attaching, setAttaching] = useState<RelatedLine | null | undefined>(undefined);
  const [pickedTitle, setPickedTitle] = useState("");
  const store: ItemStore = useMemo(() => ({ get: (key) => items[key] ?? PENDING, set: (key, state) => setItems((before) => ({ ...before, [key]: state })) }), [items]);
  const numbers = useMemo(() => chatNumbers(messages), [messages]);
  const on = (feature: FeatureName) => isFeatureOn(capabilities.data, feature);
  const abilities: DecomposeAbilities = {
    write: !readOnly,
    fold: on("fold"),
    chapters: on("chapters"),
    parking: on("parking"),
    relations: on("relations"),
    spinoff: on("spinoff"),
    tags: Boolean(rootLine) && rootLine?.conversationBranch === null,
  };
  const data = plan.data;
  const tags = useMemo(() => (data ? filterSuggestedTags(data.suggestedTags, rootLine?.title ?? line.title, tenantTags) : []), [data, rootLine?.title, line.title, tenantTags]);
  const spinoff = data ? spinoffCandidate(data.chapterCuts, numbers) : null;
  const total = data ? countSuggestions(data, tags, abilities) : 0;
  // Tags count once (as in `countSuggestions`), when a tag added here is still on the main line; seeds count one by one.
  const applied =
    Object.entries(items).reduce((sum, [key, state]) => sum + (!key.startsWith("tag:") && state.status === "applied" ? (state.count ?? 1) : 0), 0) +
    (tags.some((tag) => items[`tag:${tag}`]?.status === "applied" && rootLine?.tags.includes(tag)) ? 1 : 0);
  const highlight = useCallback((detour: DetourRange | null) => onHighlight(detour ? rangeMessageIds(messages, detour.fromMessageId, detour.toMessageId) : []), [messages, onHighlight]);
  const firstUser = messages.find((message) => message.kind === "chat" && message.role === "user");
  const cards = data ? visibleCards(data, tags, abilities, spinoff) : null;
  let n = 0;
  const next = () => (n += 1);

  return (
    <aside
      aria-label={t("decompose.title")}
      className={cx("flex h-full min-h-0 flex-col bg-tg-background text-tg-foreground", variant === "side" ? "w-100 shrink-0 border-l border-tg-border" : "w-full")}
    >
      <header className="flex shrink-0 items-start gap-2.5 border-b border-tg-border py-2.5 pr-2.5 pl-4">
        <Sparkles aria-hidden className="mt-0.5 size-4.5 shrink-0 text-tg-suggestion" />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 text-tg-md font-semibold text-tg-foreground-strong">{t("decompose.title")}</h2>
          <p className="m-0 text-tg-xs text-tg-muted">{t("decompose.sub", { applied, total })}</p>
        </div>
        <IconButton label={t("decompose.close")} icon={<X />} size="sm" onClick={onClose} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3.5">
        {readOnly && <p className="m-0 text-tg-xs text-tg-muted">{t("decompose.readOnly")}</p>}
        {plan.isPending && (
          <div role="status" className="flex flex-col gap-3">
            <span className="text-tg-sm text-tg-muted">{t("decompose.loading")}</span>
            <CardSkeletons />
          </div>
        )}
        {plan.isError && (
          <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm">
            {t("decompose.failed", { reason: describeError(plan.error, ui, hostErrorText) })}
            <Button size="sm" onClick={() => void plan.refetch()}>
              {t("decompose.retry")}
            </Button>
          </div>
        )}
        {data && cards && total === 0 && !cards.related && <p className="m-0 text-tg-sm text-tg-muted">{t("decompose.empty")}</p>}
        {data?.truncated && <p className="m-0 text-tg-xs text-tg-muted">{t("decompose.truncated")}</p>}
        {data && cards?.detours && (
          <DetourCard
            number={next()}
            lineId={line.id}
            detours={data.detourRanges}
            numbers={numbers}
            available={(detour) => detourAvailable(detour, messages)}
            abilities={abilities}
            store={store}
            onExtract={setExtracting}
            onHighlight={highlight}
            onNavigate={(lineId) => onNavigate(lineId)}
          />
        )}
        {data && cards?.chapters && (
          <ChaptersCard
            number={next()}
            rootLineId={rootLine?.id ?? line.id}
            lineId={line.id}
            cuts={data.chapterCuts}
            numbers={numbers}
            firstTitle={(firstUser?.content ?? "").replace(/\s+/g, " ").slice(0, 40)}
            abilities={abilities}
            store={store}
          />
        )}
        {data && cards?.tagsAndSeeds && (
          <TagsSeedsCard number={next()} line={rootLine} tags={tags} seeds={data.seedCandidates} lineId={line.id} rootLineId={rootLine?.id ?? line.id} abilities={abilities} store={store} />
        )}
        {data && (cards?.related || abilities.write) && (
          <RelatedCard
            number={next()}
            rootLineId={rootLine?.id ?? line.id}
            plan={data}
            spinoff={spinoff}
            numbers={numbers}
            abilities={abilities}
            store={store}
            onNavigate={(lineId) => onNavigate(lineId)}
            onSpinoff={onSpinoff}
            onAttach={setAttaching}
            pickedTitle={pickedTitle}
          />
        )}
      </div>
      {attaching !== undefined && (
        <Suspense fallback={null}>
          <AttachLineDialog
            open
            onOpenChange={(open) => {
              if (open) return;
              const target = attaching ? attaching.lineId : "other";
              setAttaching(undefined);
              // The dialog unmounts with this state: focus goes to 前往支線 after an attach, else back to the button that opened it.
              requestAnimationFrame(() => attachFocusTarget(target)?.focus());
            }}
            line={line}
            messages={messages}
            rootLineId={rootLine?.id ?? line.id}
            source={attaching ? { lineId: attaching.lineId, title: attaching.title } : null}
            onAttached={(result, source) => {
              const related = data?.relatedLines.some((item) => item.lineId === source.lineId) ?? false;
              if (!related) setPickedTitle(source.title);
              store.set(related ? attachKey(source.lineId) : ATTACH_OTHER_KEY, { status: "applied", branchLineId: result.branch.lineId });
              onAttached?.(result);
            }}
          />
        </Suspense>
      )}
      {extracting && (
        <Suspense fallback={null}>
          <ExtractBranchDialog
            open
            onOpenChange={(open) => {
              if (open) return;
              setExtracting(null);
              onHighlight([]);
            }}
            line={line}
            messages={messages}
            branches={branches}
            {...(cutMessageIds ? { cutMessageIds } : {})}
            triggerMessageId={extracting.fromMessageId}
            prefill={{ toMessageId: extracting.toMessageId, purpose: extracting.purpose, conclusion: extracting.suggestedConclusion }}
            onRangeChange={onHighlight}
            onExtracted={(result) => {
              store.set(`detour:${extracting.fromMessageId}`, { status: "applied", branchLineId: result.branch.lineId });
              onExtracted?.(result);
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}

export default DecomposePanel;
