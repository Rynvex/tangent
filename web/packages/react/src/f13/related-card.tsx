/**
 * ④ 相關對話與拆分 of the decompose panel (F13 S4, F15): each related
 * conversation can be linked (relations), opened or attached as a branch of
 * this one (B20, 併為支線…); any other conversation can be attached from the
 * loaded list (併入其他既有對話…); and a split into a new conversation.
 */
import type { ChapterCutSuggestion, DecomposePlan, RelatedLine } from "@tangent/client";
import { ArrowUpRight, ExternalLink, GitBranchPlus, Link2, Split } from "lucide-react";
import { useCreateRelation, useDeleteRelation } from "../data/p2-hooks";
import { useAttachT } from "../i18n/attach-messages";
import { useF13T } from "../i18n/f13-messages";
import { CardButton, DecomposeCard, ItemStatus, LinkButton, type ItemState } from "./decompose-cards";
import type { DecomposeAbilities } from "./decompose-model";
import { busy, useRunner, useUndo, type ItemStore } from "./decompose-sections";

/** The item key of an attach: a related line's, or the one picked from the list. */
export const attachKey = (lineId: string) => `attach:${lineId}`;
export const ATTACH_OTHER_KEY = "attach:other";

/**
 * Where focus goes when an attach dialog closes: after an attach the item's 前往支線 (its 併為支線… is gone), after a
 * cancel the button that opened it.
 */
export function attachFocusTarget(attachId: string): HTMLElement | null {
  const id = CSS.escape(attachId);
  return (
    document.querySelector<HTMLElement>(`[data-tg-attach-status="${id}"] button`) ??
    document.querySelector<HTMLElement>(attachId === "other" ? "[data-tg-attach-other] button" : `[data-tg-attach-trigger="${id}"] button`)
  );
}

export interface RelatedCardProps {
  number: number;
  rootLineId: string;
  plan: DecomposePlan;
  spinoff: ChapterCutSuggestion | null;
  numbers: ReadonlyMap<string, number>;
  abilities: DecomposeAbilities;
  store: ItemStore;
  onNavigate: (lineId: string) => void;
  onSpinoff?: ((messageId: string) => void) | undefined;
  /** Opens the attach dialog for a related line, or (null) to pick any other conversation. */
  onAttach?: ((related: RelatedLine | null) => void) | undefined;
  /** The title of the conversation the picker attached last. */
  pickedTitle?: string;
}

/** 已併為支線 with its 前往支線 under an attached item. */
function Attached({ state, text, onNavigate, attachId }: { state: ItemState; text: string; onNavigate: (lineId: string) => void; attachId: string }) {
  const t = useAttachT();
  const branchLineId = state.status === "applied" ? state.branchLineId : undefined;
  return (
    <div data-tg-attach-status={attachId} className="contents">
    <ItemStatus
      state={state}
      appliedText={text}
      extra={
        branchLineId ? (
          <LinkButton icon={<ArrowUpRight aria-hidden />} onClick={() => onNavigate(branchLineId)}>
            {t("attach.goTo")}
          </LinkButton>
        ) : undefined
      }
    />
    </div>
  );
}

function RelatedRow({ related, abilities, store, rootLineId, onNavigate, onAttach }: { related: RelatedLine } & Pick<RelatedCardProps, "abilities" | "store" | "rootLineId" | "onNavigate" | "onAttach">) {
  const t = useF13T();
  const at = useAttachT();
  const relate = useCreateRelation(rootLineId);
  const unrelate = useDeleteRelation(rootLineId);
  const run = useRunner(store);
  const undo = useUndo(store);
  const key = `link:${related.lineId}`;
  const state = store.get(key);
  const attached = store.get(attachKey(related.lineId));
  const reason = [related.sharedTags.length === 0 ? t("decompose.sameFolder") : null, related.sharedTags.length > 0 ? t("decompose.sharedTags", { tags: related.sharedTags.map((tag) => `#${tag}`).join("、") }) : null]
    .filter(Boolean)
    .join("・");
  return (
    <div data-tg-related={related.lineId} className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-border bg-tg-surface px-2.5 py-2">
      <span className="text-tg-sm font-medium text-tg-foreground-strong">{related.title}</span>
      <span className="text-tg-xs text-tg-muted">{reason}</span>
      <div className="flex flex-wrap items-center gap-2">
        {abilities.write && abilities.relations && state.status !== "applied" && attached.status !== "applied" && (
          <CardButton
            disabled={busy(state)}
            icon={<Link2 aria-hidden />}
            onClick={() =>
              void run(key, async () => {
                const made = await relate.mutateAsync({ toLineId: related.lineId });
                return { status: "applied", undo: () => unrelate.mutateAsync({ relationId: made.relation.id, otherLineId: related.lineId }) };
              })
            }
          >
            {t("decompose.link")}
          </CardButton>
        )}
        {abilities.write && onAttach && attached.status !== "applied" && (
          <span data-tg-attach-trigger={related.lineId} className="contents">
            <CardButton icon={<GitBranchPlus aria-hidden />} onClick={() => onAttach(related)}>
              {at("attach.action")}
            </CardButton>
          </span>
        )}
        {attached.status !== "applied" && (
          <LinkButton icon={<ArrowUpRight aria-hidden />} onClick={() => onNavigate(related.lineId)}>
            {t("decompose.open")}
          </LinkButton>
        )}
      </div>
      <ItemStatus state={state} appliedText={t("decompose.linked")} {...(state.status === "applied" ? { onUndo: () => undo(key) } : {})} />
      <Attached state={attached} text={at("attach.applied")} onNavigate={onNavigate} attachId={related.lineId} />
    </div>
  );
}

export function RelatedCard({ number, rootLineId, plan, spinoff, numbers, abilities, store, onNavigate, onSpinoff, onAttach, pickedTitle = "" }: RelatedCardProps) {
  const t = useF13T();
  const at = useAttachT();
  const settled = (lineId: string) => store.get(`link:${lineId}`).status === "applied" || store.get(attachKey(lineId)).status === "applied";
  return (
    <DecomposeCard number={number} title={t("decompose.related")} applied={plan.relatedLines.length > 0 && plan.relatedLines.every((related) => settled(related.lineId))}>
      {plan.relatedLines.map((related) => (
        <RelatedRow key={related.lineId} related={related} abilities={abilities} store={store} rootLineId={rootLineId} onNavigate={onNavigate} onAttach={onAttach} />
      ))}
      {spinoff && abilities.spinoff && abilities.write && onSpinoff && (
        <div className="flex flex-col gap-1.5 rounded-tg-sm bg-tg-warning-soft px-2.5 py-2">
          <span className="flex items-center gap-1.5 text-tg-sm font-medium text-tg-foreground-strong">
            <Split aria-hidden className="size-3.5 text-tg-warning" />
            {t("decompose.spinoffHint", { n: numbers.get(spinoff.messageId) ?? "?" })}
          </span>
          <span className="text-tg-xs text-tg-muted">{t("decompose.spinoffBody", { n: numbers.get(spinoff.messageId) ?? "?", title: spinoff.title })}</span>
          <div>
            <CardButton icon={<ExternalLink aria-hidden />} onClick={() => onSpinoff(spinoff.messageId)}>
              {t("decompose.spinoff", { n: numbers.get(spinoff.messageId) ?? "?" })}
            </CardButton>
          </div>
        </div>
      )}
      {abilities.write && onAttach && (
        <div className="flex flex-col gap-1.5">
          <div data-tg-attach-other="" className="contents">
            <div>
              <CardButton icon={<GitBranchPlus aria-hidden />} onClick={() => onAttach(null)}>
                {at("attach.other")}
              </CardButton>
            </div>
          </div>
          <Attached state={store.get(ATTACH_OTHER_KEY)} text={at("attach.appliedOther", { title: pickedTitle })} onNavigate={onNavigate} attachId="other" />
        </div>
      )}
    </DecomposeCard>
  );
}
