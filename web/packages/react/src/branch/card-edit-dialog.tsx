import {
  CARD_FIELD_MAX,
  CARD_OPEN_ITEMS_MAX,
  CARD_TOTAL_MAX,
  cardRequestBody,
  classifyCardEditError,
  emptyCard,
  validateCard,
  type BranchCard,
  type BranchView,
  type CardEditFailure,
  type Message,
  type UpdateBranchCardResult,
} from "@tangent/client";
import { Info, Pencil, Plus, TriangleAlert, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { IconButton } from "../components/icon-button";
import { TextArea, TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useUpdateBranchCard } from "../data/branch-mutations";
import { useF12T, type F12MessageKey } from "../i18n/f12-messages";
import { useTangent } from "../provider";

export interface BranchCardEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The merged branch whose card is edited. */
  branch: BranchView;
  /** Its `branch_card` message on the parent line. */
  message: Message;
  onSaved?: (result: UpdateBranchCardResult) => void;
}

interface Draft {
  question: string;
  conclusion: string;
  impact: string;
  openItems: string[];
}

function draftOf(card: BranchCard): Draft {
  return { question: card.question, conclusion: card.conclusion, impact: card.impact, openItems: [...card.openItems] };
}

/** What would be sent (trimmed, empty rows out), so whitespace alone is no change. */
const sameRequest = (a: BranchCard, b: BranchCard) => JSON.stringify(cardRequestBody(a)) === JSON.stringify(cardRequestBody(b));

/** The reason a refused save gives (decision: `parent_busy` asks to wait for the reply). */
const FAILURE_KEYS: Partial<Record<CardEditFailure["kind"], F12MessageKey>> = {
  parent_busy: "card.parentBusy",
  parent_closed: "card.parentClosed",
  archived: "card.archived",
  branch_closed: "card.branchClosed",
};

/** One field's message: a problem the form found first, else the server's. */
function fieldError(t: ReturnType<typeof useF12T>, field: string, local: ReturnType<typeof validateCard>, server: Readonly<Record<string, string>>): string | null {
  const problem = local.find((item) => item.field === field);
  if (problem?.code === "required") return field === "question" ? t("card.questionRequired") : field === "conclusion" ? t("card.conclusionRequired") : t("card.openItemRequired");
  if (problem?.code === "tooLong") return t("card.tooLong", { limit: CARD_FIELD_MAX });
  return server[field] ?? null;
}

function EditForm({ branch, message, onOpenChange, onSaved }: Omit<BranchCardEditDialogProps, "open">) {
  const t = useF12T();
  const { hostErrorText } = useTangent();
  const original = message.meta.card ?? { ...emptyCard(), conclusion: message.content };
  const [draft, setDraft] = useState(() => draftOf(original));
  const [shown, setShown] = useState(false);
  const [failure, setFailure] = useState<CardEditFailure | null>(null);
  const update = useUpdateBranchCard(branch.lineId);
  const conclusionRef = useRef<HTMLTextAreaElement>(null);
  const card: BranchCard = { ...original, ...draft };
  const problems = validateCard(card);
  const serverProblems = failure?.kind === "invalid_card" ? Object.fromEntries(failure.problems.map((problem) => [problem.field, problem.message])) : {};
  const changed = !sameRequest(card, original);
  const show = (field: string) => (shown ? fieldError(t, field, problems, serverProblems) : (serverProblems[field] ?? null));
  const save = () => {
    setShown(true);
    if (problems.length > 0 || !changed || update.isPending) return;
    setFailure(null);
    update.mutateAsync({ card: cardRequestBody(card) }).then(
      (result) => {
        onOpenChange(false);
        onSaved?.(result);
      },
      (error: unknown) => setFailure(classifyCardEditError(error)),
    );
  };
  const setItem = (index: number, value: string) => setDraft({ ...draft, openItems: draft.openItems.map((item, at) => (at === index ? value : item)) });
  const reason = failure && failure.kind !== "invalid_card" ? (FAILURE_KEYS[failure.kind] ? t(FAILURE_KEYS[failure.kind]!) : describeError(failure.kind === "other" ? failure.error : null, t, hostErrorText)) : null;
  const total = problems.some((problem) => problem.code === "total");
  return (
    <DialogContent
      width="lg"
      initialFocus={conclusionRef}
      title={
        <span className="inline-flex items-center gap-2">
          <Pencil aria-hidden className="size-4.5 text-tg-primary-text" />
          {t("card.editTitle")}
        </span>
      }
      description={t("card.editSubtitle", { title: branch.purpose })}
      footer={
        <>
          <span className="mr-auto self-center text-tg-xs text-tg-muted max-sm:hidden">{t("card.editFoot", { max: CARD_OPEN_ITEMS_MAX })}</span>
          <DialogClose render={<Button disabled={update.isPending}>{t("card.cancel")}</Button>} />
          <Button variant="primary" loading={update.isPending} disabled={!changed} aria-disabled={!changed || undefined} onClick={save}>
            {t("card.save")}
          </Button>
        </>
      }
    >
      <TextField label={t("card.questionLabel")} value={draft.question} required error={show("question")} onChange={(event) => setDraft({ ...draft, question: event.target.value })} />
      <TextArea ref={conclusionRef} label={t("card.conclusionLabel")} rows={4} value={draft.conclusion} required error={show("conclusion")} onChange={(event) => setDraft({ ...draft, conclusion: event.target.value })} />
      <TextArea label={t("card.impactLabel")} rows={2} value={draft.impact} error={show("impact")} onChange={(event) => setDraft({ ...draft, impact: event.target.value })} />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-tg-sm font-medium text-tg-foreground">{t("card.openItemsLabel")}</legend>
        {draft.openItems.map((item, index) => (
          <div key={index} className="flex items-start gap-1.5">
            <TextField
              aria-label={t("card.openItemLabel", { n: index + 1 })}
              className="min-w-0 flex-1"
              value={item}
              error={show(`openItems[${index}]`)}
              onChange={(event) => setItem(index, event.target.value)}
            />
            <IconButton label={t("card.openItemRemove")} icon={<X />} tooltip={false} onClick={() => setDraft({ ...draft, openItems: draft.openItems.filter((_, at) => at !== index) })} />
          </div>
        ))}
        {draft.openItems.length < CARD_OPEN_ITEMS_MAX && (
          <Button size="sm" variant="ghost" className="self-start" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setDraft({ ...draft, openItems: [...draft.openItems, ""] })}>
            {t("card.openItemAdd")}
          </Button>
        )}
      </fieldset>
      {shown && total && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {t("card.tooMuch", { limit: CARD_TOTAL_MAX })}
        </p>
      )}
      {reason && (
        <div role="alert" className="flex items-start gap-2 rounded-tg-sm bg-tg-destructive-soft px-3 py-2 text-tg-sm text-tg-foreground">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-tg-destructive" />
          <span>{t("card.saveFailed", { reason })}</span>
        </div>
      )}
      <p className="m-0 flex items-start gap-2 text-tg-xs text-tg-muted">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {t("card.editNote")}
      </p>
    </DialogContent>
  );
}

/**
 * S6 BranchCardEditDialog (w600, full screen on phones; B17 `PATCH
 * /branch/card`): the question, the conclusion, the impact and the open
 * questions (remove each, add more) of a merged branch's card; the other
 * fields (evidence, decisions, quotes) are kept as they are. Opens on the
 * conclusion. 儲存 is off while nothing changed; a refused save keeps the
 * edits and says why (a parent mid-turn asks to wait for the reply). Saved,
 * the card says 已修改・下一輪帶入 until the parent's next turn carries it.
 * No old version is kept (decision #7).
 */
export function BranchCardEditDialog({ open, onOpenChange, ...rest }: BranchCardEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <EditForm key={rest.message.id} onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
