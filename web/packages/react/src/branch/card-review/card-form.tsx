import { useDialogT } from "../../i18n/dialog-messages";
import { cardHasAdvancedContent, chatMessages, chatNumbers, type BranchCard, type CardAction, type Message } from "@tangent/client";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/button";
import { TextArea, TextField } from "../../components/text-field";
import { strayErrors } from "./card-errors";
import { DecisionsList, EvidenceList, ExcerptsList, FieldError, OpenItemsList } from "./card-lists";

export interface CardFormProps {
  card: BranchCard;
  edit: (action: CardAction) => void;
  errors: Readonly<Record<string, string>>;
  /** The branch's messages (evidence and excerpts point at them). */
  branchMessages: readonly Message[];
  /** The parent's messages ("#n" of the decisions' main-line side). */
  parentMessages: readonly Message[];
}

function Required({ label }: { label: string }) {
  const t = useDialogT();
  return (
    <span>
      {label}
      <span className="text-tg-destructive">{t("review.required")}</span>
    </span>
  );
}

const ADVANCED_FIELD = /^(impact|evidence|openItems|needsDecision|excerpts)\b/;

/**
 * The optional fields under a disclosure (F10 §4.1): open from the start when
 * any of them has content, opened when content arrives (an AI draft), and
 * always shown while one of them has a problem (the review focuses it).
 */
function AdvancedFields({ card, errors, children }: { card: BranchCard; errors: Readonly<Record<string, string>>; children: ReactNode }) {
  const t = useDialogT();
  const id = useId();
  const hasContent = cardHasAdvancedContent(card);
  const [open, setOpen] = useState(hasContent);
  useEffect(() => {
    if (hasContent) setOpen(true);
  }, [hasContent]);
  const expanded = open || Object.keys(errors).some((field) => ADVANCED_FIELD.test(field));
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setOpen(!expanded)}
        className="self-start text-tg-primary-text"
      >
        {t(expanded ? "review.advancedHide" : "review.advancedShow")}
        <ChevronDown aria-hidden className={`size-3.5 motion-safe:transition-transform ${expanded ? "rotate-180" : ""}`} />
      </Button>
      <div id={id} hidden={!expanded} className="flex flex-col gap-4.5">
        {children}
      </div>
    </>
  );
}

/** Every field of the card, editable (A5): question and conclusion, then evidence, impact, open items, decisions and excerpts under a disclosure. */
export function CardForm({ card, edit, errors, branchMessages, parentMessages }: CardFormProps) {
  const t = useDialogT();
  const chat = useMemo(() => chatMessages(branchMessages), [branchMessages]);
  const numbers = useMemo(() => chatNumbers(branchMessages), [branchMessages]);
  const mainNumbers = useMemo(() => chatNumbers(parentMessages), [parentMessages]);
  return (
    <div className="flex flex-col gap-4.5">
      <TextField
        label={<Required label={t("card.question")} />}
        value={card.question}
        error={errors.question}
        onChange={(event) => edit({ type: "setText", field: "question", value: event.target.value })}
      />
      <TextArea
        label={<Required label={t("card.conclusion")} />}
        rows={3}
        value={card.conclusion}
        placeholder={t("review.conclusionPlaceholder")}
        error={errors.conclusion}
        inputClassName="font-tg-serif text-tg-reading leading-[1.6]"
        onChange={(event) => edit({ type: "setText", field: "conclusion", value: event.target.value })}
      />
      <AdvancedFields card={card} errors={errors}>
        <EvidenceList card={card} edit={edit} errors={errors} messages={chat} numbers={numbers} />
        <TextArea label={t("card.impact")} rows={2} value={card.impact} error={errors.impact} onChange={(event) => edit({ type: "setText", field: "impact", value: event.target.value })} />
        <OpenItemsList card={card} edit={edit} errors={errors} />
        <DecisionsList card={card} edit={edit} errors={errors} mainNumbers={mainNumbers} />
        <ExcerptsList card={card} edit={edit} errors={errors} />
      </AdvancedFields>
      <FieldError text={errors.card} />
      {strayErrors(errors, card).map(([field, text]) => (
        <FieldError key={field} text={`${field}: ${text}`} />
      ))}
    </div>
  );
}
