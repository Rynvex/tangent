import { useDialogT } from "../../i18n/dialog-messages";
import {
  CARD_DECISIONS_MAX,
  CARD_EVIDENCE_MAX,
  CARD_EXCERPTS_MAX,
  CARD_EXCERPT_CHARS_MAX,
  CARD_OPEN_ITEMS_MAX,
  checkExcerptSelection,
  previewLine,
  type BranchCard,
  type CardAction,
  type ExcerptRejection,
  type Message,
} from "@tangent/client";
import { Eye, Plus, TriangleAlert, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/button";
import { IconButton } from "../../components/icon-button";
import { Select } from "../../components/select";
import { TextArea, TextField } from "../../components/text-field";
import type { DialogMessageKey } from "../../i18n/dialog-messages";
import { readMessageSelection } from "../selection-toolbar";
import { rowError } from "./card-errors";

type Edit = (action: CardAction) => void;

const REJECTION_KEYS: Record<ExcerptRejection, DialogMessageKey> = {
  unknownMessage: "review.excerpt.unknownMessage",
  empty: "review.excerpt.empty",
  tooLong: "review.excerpt.tooLong",
  limit: "review.excerpt.limit",
  duplicate: "review.excerpt.duplicate",
  notVerbatim: "review.excerpt.notVerbatim",
  unclean: "review.excerpt.unclean",
};

export function ListHeader({ label, count, max, onAdd, error }: { label: string; count: number; max: number; onAdd: () => void; error?: string | undefined }) {
  const t = useDialogT();
  return (
    <>
    <div className="flex items-center justify-between gap-2">
      <span className="text-tg-xs font-semibold text-tg-muted">{t("review.listCount", { label, count, max })}</span>
      {count < max && (
        <Button variant="ghost" size="sm" icon={<Plus aria-hidden className="size-3" />} onClick={onAdd} className="text-tg-primary-text">
          {t("review.add")}
        </Button>
      )}
    </div>
    <FieldError text={error} />
    </>
  );
}

function RemoveButton({ onClick }: { onClick: () => void }) {
  const t = useDialogT();
  return <IconButton label={t("review.remove")} icon={<X />} size="sm" tooltip={false} onClick={onClick} />;
}

/** A problem shown under a row or a list; `data-card-error` lets the review scroll to the first one. */
export function FieldError({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p data-card-error="" className="m-0 text-tg-xs text-tg-destructive">
      {text}
    </p>
  );
}

/** The original text of a branch message; selecting part of it can become a quoted excerpt. */
function SourcePreview({ message, number, card, messages, edit, onClose }: { message: Message; number: number; card: BranchCard; messages: readonly Message[]; edit: Edit; onClose: () => void }) {
  const t = useDialogT();
  const box = useRef<HTMLDivElement>(null);
  const [rejection, setRejection] = useState<ExcerptRejection | null>(null);
  const add = () => {
    const selection = readMessageSelection(box.current) ?? { messageId: message.id, text: "", forkable: true };
    const check = checkExcerptSelection(card, messages, selection);
    setRejection(check.ok ? null : check.reason);
    if (check.ok) edit({ type: "addExcerpt", excerpt: check.excerpt });
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-primary bg-tg-primary-soft p-2.5">
      <div className="flex items-center gap-2 text-tg-xs font-medium text-tg-foreground">
        <span className="flex-1">{t("review.evidenceOpen", { n: number })}</span>
        <Button size="sm" onMouseDown={(event) => event.preventDefault()} onClick={add}>
          {t("review.excerptAdd")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("review.previewClose")}
        </Button>
      </div>
      <div ref={box}>
        <pre data-message-id={message.id} tabIndex={0} className="m-0 max-h-48 overflow-auto font-tg-sans text-tg-xs whitespace-pre-wrap text-tg-foreground">
          {message.content}
        </pre>
      </div>
      {rejection && <p className="m-0 text-tg-xs text-tg-destructive">{t(REJECTION_KEYS[rejection], { max: rejection === "limit" ? CARD_EXCERPTS_MAX : CARD_EXCERPT_CHARS_MAX })}</p>}
    </div>
  );
}

export interface ListProps {
  card: BranchCard;
  edit: Edit;
  errors: Readonly<Record<string, string>>;
}

export function EvidenceList({ card, edit, errors, messages, numbers }: ListProps & { messages: readonly Message[]; numbers: ReadonlyMap<string, number> }) {
  const t = useDialogT();
  const [preview, setPreview] = useState<number | null>(null);
  const options = messages.map((message) => ({ value: message.id, label: `#${numbers.get(message.id) ?? "?"}・${previewLine(message)}` }));
  return (
    <section className="flex flex-col gap-1.5">
      <ListHeader label={t("card.evidence")} count={card.evidence.length} max={CARD_EVIDENCE_MAX} onAdd={() => edit({ type: "addEvidence" })} error={errors.evidence} />
      {card.evidence.map((item, index) => {
        const source = messages.find((message) => message.id === item.messageId);
        const number = numbers.get(item.messageId);
        return (
          <div key={index} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={t("review.evidenceMessage")}
                options={options}
                value={item.messageId || null}
                placeholder={t("review.evidencePick")}
                onValueChange={(messageId) => edit({ type: "setEvidence", index, patch: { messageId } })}
                className="w-40"
              />
              <TextField aria-label={t("review.evidenceNote")} value={item.note} aria-invalid={errors[`evidence[${index}].note`] ? true : undefined} className="min-w-40 flex-1" onChange={(event) => edit({ type: "setEvidence", index, patch: { note: event.target.value } })} />
              {source && number !== undefined && (
                <IconButton label={t("review.evidenceOpen", { n: number })} icon={<Eye />} size="sm" tooltip={false} pressed={preview === index} onClick={() => setPreview(preview === index ? null : index)} />
              )}
              <RemoveButton onClick={() => edit({ type: "removeEvidence", index })} />
            </div>
            <FieldError text={errors[`evidence[${index}].note`]} />
            <FieldError text={rowError(errors, "evidence", index, ["note"])} />
            {preview === index && source && number !== undefined && (
              <SourcePreview message={source} number={number} card={card} messages={messages} edit={edit} onClose={() => setPreview(null)} />
            )}
          </div>
        );
      })}
    </section>
  );
}

export function OpenItemsList({ card, edit, errors }: ListProps) {
  const t = useDialogT();
  return (
    <section className="flex flex-col gap-1.5">
      <ListHeader label={t("card.openItems")} count={card.openItems.length} max={CARD_OPEN_ITEMS_MAX} onAdd={() => edit({ type: "addOpenItem" })} error={errors.openItems} />
      {card.openItems.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <TextField
            aria-label={t("review.openItem", { n: index + 1 })}
            value={item}
            error={errors[`openItems[${index}]`]}
            className="flex-1"
            onChange={(event) => edit({ type: "setOpenItem", index, value: event.target.value })}
          />
          <RemoveButton onClick={() => edit({ type: "removeOpenItem", index })} />
        </div>
      ))}
    </section>
  );
}

export function DecisionsList({ card, edit, errors, mainNumbers }: ListProps & { mainNumbers: ReadonlyMap<string, number> }) {
  const t = useDialogT();
  if (card.needsDecision.length === 0) {
    return <ListHeader label={t("card.needsDecision")} count={0} max={CARD_DECISIONS_MAX} onAdd={() => edit({ type: "addDecision" })} error={errors.needsDecision} />;
  }
  return (
    <section className="flex flex-col gap-2 rounded-tg bg-tg-warning-soft p-3">
      <span className="inline-flex items-center gap-1.5 text-tg-xs font-semibold text-tg-warning">
        <TriangleAlert aria-hidden className="size-3.5" />
        {t("review.decisionsHint")}
      </span>
      <ListHeader label={t("card.needsDecision")} count={card.needsDecision.length} max={CARD_DECISIONS_MAX} onAdd={() => edit({ type: "addDecision" })} error={errors.needsDecision} />
      {card.needsDecision.map((item, index) => {
        const number = item.mainLineMessageId ? mainNumbers.get(item.mainLineMessageId) : undefined;
        return (
          <div key={index} className="flex flex-col gap-1">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))_auto] items-start gap-2">
              <TextArea label={t("card.branchClaim")} rows={2} value={item.branchClaim} error={errors[`needsDecision[${index}].branchClaim`]} onChange={(event) => edit({ type: "setDecision", index, patch: { branchClaim: event.target.value } })} />
              <TextArea
                label={number === undefined ? t("card.mainClaimNoRef") : t("card.mainClaim", { n: number })}
                rows={2}
                value={item.mainLineClaim}
                error={errors[`needsDecision[${index}].mainLineClaim`]}
                onChange={(event) => edit({ type: "setDecision", index, patch: { mainLineClaim: event.target.value } })}
              />
              <RemoveButton onClick={() => edit({ type: "removeDecision", index })} />
            </div>
            <FieldError text={rowError(errors, "needsDecision", index, ["branchClaim", "mainLineClaim"])} />
          </div>
        );
      })}
    </section>
  );
}

export function ExcerptsList({ card, edit, errors }: ListProps): ReactNode {
  const t = useDialogT();
  if (card.excerpts.length === 0) return <FieldError text={errors.excerpts} />;
  return (
    <section className="flex flex-col gap-1.5">
      <span className="text-tg-xs font-semibold text-tg-muted">{t("review.listCount", { label: t("card.excerpts"), count: card.excerpts.length, max: CARD_EXCERPTS_MAX })}</span>
      <FieldError text={errors.excerpts} />
      {card.excerpts.map((item, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <code className="flex-1 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 font-tg-mono text-tg-xs whitespace-pre-wrap">{item.text}</code>
            <RemoveButton onClick={() => edit({ type: "removeExcerpt", index })} />
          </div>
          <FieldError text={rowError(errors, "excerpts", index, [])} />
        </div>
      ))}
    </section>
  );
}
