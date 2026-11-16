import {
  BRANCH_EXCERPT_MAX,
  BRANCH_OPEN_PER_PARENT_LIMIT,
  BRANCH_PURPOSE_MAX,
  BRANCH_TREE_LIMIT,
  branchLoad,
  buildCreateInput,
  charCount,
  chatMessages,
  chatNumbers,
  classifyOpenBranchError,
  countLaterMessages,
  describeBranchError,
  isFeatureOn,
  prefillPurpose,
  prepareExcerpt,
  summarizeTopic,
  askTemplatesFor,
  classifyExcerpt,
  validatePurpose,
  withSuggestion,
  type AcceptedSuggestion,
  type AskTemplateGroup,
  type AskTemplateId,
  type BranchKind,
  type BranchView,
  type CreateBranchResult,
  type LineView,
  type Message,
  type OpenBranchFailure,
} from "@tangent/client";
import { GitBranch, GitMerge } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/button";
import { Badge } from "../components/display";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { TextArea } from "../components/text-field";
import { useCreateBranch } from "../data/branch-mutations";
import { useExpandSeed } from "../data/p1-hooks";
import { useCapabilities } from "../data/queries";
import { useTangent, useUiT } from "../provider";
import { useSendFirst } from "../f8/branch-and-send";
import type { Translate } from "../i18n/types";
import { askDraft, askLabel } from "./ask-templates";
import { AskChips, PurposeSummary } from "./ask-fields";
import { useP1T } from "../i18n/p1-messages";
import { useF12T } from "../i18n/f12-messages";
import { KindRadio } from "./kind-radio";
import { LaterField, ModelField, type BranchModelOption } from "./open-branch-fields";
import { PackEstimate } from "./pack-estimate";
import { LazyBranchMemoryRecall } from "../memory/slots";

export interface OpenBranchRequest {
  /** The message to fork from (the host resolves "the last message" for ⌘B and the composer button). */
  anchorMessageId: string;
  /** Text selected in that message. */
  excerpt?: string;
  /** An AI suggestion the user accepted (A12). */
  suggestion?: AcceptedSuggestion;
  /**
   * A parked seed to expand (B3): the purpose starts from its text, the branch
   * is opened by `POST /seeds/{id}/expand` (origin seed), which decides the
   * fork point itself and takes no model or later messages.
   */
  seed?: { id: string; text: string };
  /** A purpose to start from (focus mode's 從這裡繼續談: a note's first line); the excerpt's start otherwise. */
  purpose?: string;
  /** One line under the excerpt saying why the branch forks where it does (an ended line's notes fork from its parent). */
  notice?: string;
  /** F10: the first question to start from (the Feynman check's prompt); no templates are offered then. */
  question?: string;
  /**
   * F12 S6 繼續追問 (B17): `anchorMessageId` is a conclusion card. The dialog
   * says the original branch stays merged, quotes the conclusion (the card
   * is in the background already, so no excerpt is sent) and offers the
   * card's open questions as quick picks next to the usual ones.
   */
  fromCard?: { title: string; conclusion: string; openItems: readonly string[] };
  /** F18: when the branch is opened as an aside, keep it from the start (the conversation's default is 保留). */
  keepAside?: boolean;
}

/** F10: what happened after the branch opened — the first question, and whether it was sent (a failed send's error). */
export interface OpenBranchOutcome {
  question: string;
  sent: boolean;
  sendError?: unknown;
}

export interface OpenBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The parent line. */
  line: LineView;
  /** The parent line's messages (fork label, background estimate, later messages). */
  messages: readonly Message[];
  /** The tree's outline (the per-line and per-tree limits). */
  branches: readonly BranchView[];
  request: OpenBranchRequest | null;
  /** Providers / models the server allows besides the parent's (host-supplied). */
  modelOptions?: readonly BranchModelOption[];
  onCreated: (result: CreateBranchResult, outcome: OpenBranchOutcome) => void;
}

const NO_OPTIONS: readonly BranchModelOption[] = [];

function Alert({ tone, children }: { tone: "warning" | "destructive"; children: ReactNode }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-2 rounded-tg-sm px-3 py-2 text-tg-sm text-tg-foreground ${tone === "warning" ? "bg-tg-warning-soft" : "bg-tg-destructive-soft"}`}>
      {children}
    </div>
  );
}

interface FormProps extends Omit<OpenBranchDialogProps, "open" | "request"> {
  request: OpenBranchRequest;
}

function useKinds(): BranchKind[] {
  const capabilities = useCapabilities();
  return isFeatureOn(capabilities.data, "aside") ? ["aside", "investigate", "alternative"] : ["investigate", "alternative"];
}

/** What the templates work on: a card's conclusion (F12), the selection, else a seed's text; none (general templates) for a plain 開支線. */
function askSource(request: OpenBranchRequest, excerpt: string): { group: AskTemplateGroup; text: string } {
  if (request.fromCard) return { group: "sentence", text: request.fromCard.conclusion };
  const text = excerpt || request.seed?.text || "";
  return { group: text ? classifyExcerpt(text) : "general", text };
}

/** F12: a chip for one of the card's open questions. */
const OPEN_ITEM_CHIP = "open:";

/** The first question and purpose a chip makes: a template's, or (F12) an open question asked as written. */
function chipDraft(t: Translate, request: OpenBranchRequest, source: { group: AskTemplateGroup; text: string }, id: string): { question: string; purpose: string } {
  if (id.startsWith(OPEN_ITEM_CHIP)) {
    const item = request.fromCard?.openItems[Number(id.slice(OPEN_ITEM_CHIP.length))] ?? "";
    return { question: item, purpose: summarizeTopic(item) || prefillPurpose(item) };
  }
  return askDraft(t, source.group, id as AskTemplateId, source.text);
}

/** The question the dialog opens with: the host's (the Feynman check), a seed as written, a card's first open question (F12), a selection's default template, or none. */
function initialAsk(t: Translate, request: OpenBranchRequest, source: { group: AskTemplateGroup; text: string }): { template: string | null; question: string } {
  if (request.question !== undefined) return { template: null, question: request.question };
  if (request.seed) return { template: null, question: request.seed.text };
  if (request.fromCard && request.fromCard.openItems.length > 0) return { template: `${OPEN_ITEM_CHIP}0`, question: request.fromCard.openItems[0]! };
  if (source.group === "general") return { template: null, question: "" };
  const template = askTemplatesFor(source.group)[0]!;
  return { template, question: askDraft(t, source.group, template, source.text).question };
}

/** The form; keyed by the request so every open starts fresh. */
function OpenBranchForm({ line, messages, branches, request, modelOptions = NO_OPTIONS, onOpenChange, onCreated }: FormProps) {
  const t = useP1T();
  const ui = useUiT();
  const f12 = useF12T();
  const { hostErrorText } = useTangent();
  const kinds = useKinds();
  const create = useCreateBranch(line.id);
  const expand = useExpandSeed(line.conversationBranch?.rootLineId ?? line.id);
  const sendFirst = useSendFirst();
  const seed = request.seed;
  const writing = seed ? expand : create;
  const excerpt = prepareExcerpt(request.excerpt ?? "");
  const parentModel: BranchModelOption = { provider: line.provider, model: line.model };
  const source = askSource(request, excerpt.text);
  const [ask, setAsk] = useState(() => initialAsk(ui, request, source));
  // A purpose the host or the user set stays; otherwise it follows the chosen template, else the question's start.
  const fixedPurpose = request.purpose ?? request.suggestion?.purpose;
  const [ownPurpose, setOwnPurpose] = useState<string | null>(fixedPurpose ?? null);
  const fallbackPurpose = seed ? prefillPurpose(seed.text) : prefillPurpose(excerpt.text);
  // F11 §2: a question of the user's own is named after its topic (the last thing it asks), not its first characters.
  // A seed asked as written keeps its own words as the purpose.
  const ownQuestion = ask.question.trim() !== "" && ask.question !== seed?.text;
  const autoPurpose = ask.template ? chipDraft(ui, request, source, ask.template).purpose : ownQuestion ? summarizeTopic(ask.question) || prefillPurpose(ask.question) : fallbackPurpose;
  const purpose = ownPurpose ?? autoPurpose;
  // Open from the start when there is no question to name the branch after.
  const [purposeOpen, setPurposeOpen] = useState(() => !ask.question.trim());
  const [kind, setKind] = useState<BranchKind>(() => {
    const wanted = request.suggestion?.kind ?? "investigate";
    return kinds.includes(wanted) ? wanted : "investigate";
  });
  const [model, setModel] = useState(parentModel);
  const [includeLater, setIncludeLater] = useState(false);
  const [anchorId, setAnchorId] = useState(request.anchorMessageId);
  const [maxPurpose, setMaxPurpose] = useState(BRANCH_PURPOSE_MAX);
  const [showProblem, setShowProblem] = useState(false);
  const [failure, setFailure] = useState<{ kind: OpenBranchFailure; error: unknown } | null>(null);
  const [sending, setSending] = useState(false);
  // Which button ran last: its busy state, and what a confirmed deeper branch does again.
  const [lastSend, setLastSend] = useState(true);
  // D1: memories the user ticked go into the branch's background with the excerpt.
  const [remembered, setRemembered] = useState("");
  const memoryOn = isFeatureOn(useCapabilities().data, "memory");
  const background = [excerpt.text, remembered].filter(Boolean).join("\n\n").slice(0, BRANCH_EXCERPT_MAX);

  const isParentMain = line.conversationBranch === null;
  const anchorNumber = chatNumbers(messages).get(anchorId);
  const later = countLaterMessages([...messages], anchorId);
  const load = branchLoad(branches, line.id);
  const full = load.openUnderParent >= BRANCH_OPEN_PER_PARENT_LIMIT;
  const problem = validatePurpose(purpose, maxPurpose);
  const lastId = chatMessages(messages).at(-1)?.id;
  const question = ask.question.trim();
  const busy = writing.isPending || sending;

  const write = (confirmDeeper: boolean): Promise<CreateBranchResult> => {
    if (seed) return expand.mutateAsync({ seedId: seed.id, input: { purpose: purpose.trim(), kind, ...(confirmDeeper ? { confirmDeeper: true } : {}) } });
    const form = { purpose, kind, anchorMessageId: anchorId, excerpt: background, provider: model.provider, mainProvider: line.provider, model: model.model === line.model ? "" : model.model };
    const keep = request.keepAside && kind === "aside" ? { keep: true } : {};
    return create.mutateAsync(withSuggestion({ ...buildCreateInput({ ...form, includeLater: includeLater && later > 0 }), ...(confirmDeeper ? { confirmDeeper: true } : {}), ...keep }, request.suggestion));
  };

  // F10: 開啟支線並送出問題 opens the branch and asks there; a failed send still ends here (the branch is real), the host says so.
  const submit = async (send: boolean, confirmDeeper = false) => {
    setShowProblem(true);
    if (problem) setPurposeOpen(true);
    if (problem || full || busy) return;
    setFailure(null);
    let result: CreateBranchResult;
    try {
      result = await write(confirmDeeper);
    } catch (error) {
      const classified = classifyOpenBranchError(error);
      if (classified.kind === "purposeTooLong" && classified.max > 0) setMaxPurpose(classified.max);
      setFailure({ kind: classified, error });
      return;
    }
    let sendError: unknown;
    if (send && question) {
      setSending(true);
      try {
        await sendFirst(result.line.id, question);
      } catch (error) {
        sendError = error;
      }
    }
    onOpenChange(false);
    onCreated(result, { question, sent: send && question !== "" && sendError === undefined, ...(sendError !== undefined ? { sendError } : {}) });
  };
  const run = (send: boolean) => {
    if (busy) return;
    setLastSend(send);
    void submit(send);
  };
  const choose = (template: string) => setAsk({ template, question: chipDraft(ui, request, source, template).question });
  const onQuestionKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // An empty question is never sent by Enter (nor opens a branch with nothing to ask).
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || !question) return;
    event.preventDefault();
    run(true);
  };

  const purposeError = showProblem && problem === "required" ? t("branch.purposeRequired") : problem === "tooLong" ? t("branch.purposeTooLong", { limit: maxPurpose }) : null;
  const forkLabel = request.fromCard
    ? f12("branch.fromCardDescription", { title: request.fromCard.title })
    : anchorNumber === undefined
      ? t("branch.forkFromMessage")
      : isParentMain
        ? t("branch.forkFromMain", { n: anchorNumber })
        : t("branch.forkFromBranch", { n: anchorNumber });
  const templateChips = request.question === undefined ? askTemplatesFor(source.group).map((id) => ({ id: id as string, label: askLabel(ui, source.group, id) })) : [];
  const chips = request.fromCard ? [...templateChips, ...request.fromCard.openItems.map((item, index) => ({ id: `${OPEN_ITEM_CHIP}${index}`, label: f12("branch.openItemChip", { text: item }) }))] : templateChips;

  return (
    <DialogContent
      width="md"
      title={
        <span className="inline-flex items-center gap-2">
          <GitBranch aria-hidden className="size-4.5 text-tg-primary-text" />
          {t("branch.dialogTitle")}
        </span>
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          {forkLabel}
          {request.suggestion && <Badge tone="suggestion">{t("branch.suggested")}</Badge>}
          {seed && <Badge tone="neutral">{t("branch.fromSeed")}</Badge>}
        </span>
      }
      footer={
        <>
          <DialogClose render={<Button disabled={busy}>{t("branch.cancel")}</Button>} />
          {question && (
            <Button loading={busy && !lastSend} disabled={busy && lastSend} aria-disabled={full || undefined} onClick={() => run(false)}>
              {ui("branch.submitOnly")}
            </Button>
          )}
          <Button variant="primary" loading={busy && (lastSend || !question)} disabled={busy && !lastSend && question !== ""} aria-disabled={full || undefined} onClick={() => run(question !== "")}>
            {question ? ui("branch.submitAndSend") : t("branch.submit")}
          </Button>
        </>
      }
    >
      {request.fromCard && (
        <>
          <p className="m-0 rounded-tg-sm bg-tg-primary-soft px-3 py-2 text-tg-sm text-tg-foreground">{f12("branch.fromCard", { title: request.fromCard.title })}</p>
          <figure className="m-0 flex flex-col gap-1">
            <figcaption className="inline-flex items-center gap-1.5 text-tg-xs text-tg-muted">
              <GitMerge aria-hidden className="size-3.5 text-tg-branch-merged" />
              {f12("branch.quoteCard")}
            </figcaption>
            <blockquote className="m-0 max-h-24 overflow-y-auto rounded-tg-sm border-l-2 border-tg-branch-merged bg-tg-card px-3 py-2 font-tg-serif text-tg-sm whitespace-pre-wrap text-tg-foreground">{request.fromCard.conclusion}</blockquote>
          </figure>
        </>
      )}
      {excerpt.text && (
        <div className="flex flex-col gap-1">
          <blockquote className="m-0 max-h-24 overflow-y-auto rounded-tg-sm bg-tg-highlight px-3 py-2 font-tg-serif text-tg-sm whitespace-pre-wrap text-tg-foreground">{excerpt.text}</blockquote>
          {excerpt.truncated && <span className="text-tg-xs text-tg-warning">{t("branch.excerptTruncated", { limit: BRANCH_EXCERPT_MAX })}</span>}
        </div>
      )}
      {request.notice && <p className="m-0 text-tg-xs text-tg-muted">{request.notice}</p>}
      {chips.length > 0 && <AskChips chips={chips} value={ask.template} onValueChange={choose} />}
      <TextArea
        label={ui("branch.questionLabel")}
        rows={3}
        value={ask.question}
        placeholder={ui("branch.questionPlaceholder")}
        onKeyDown={onQuestionKey}
        // Emptied, the box no longer holds a template's question; typing then names the branch after what is typed.
        onChange={(event) => setAsk({ template: event.target.value.trim() ? ask.template : null, question: event.target.value })}
      />
      {purposeOpen ? (
        <TextArea
          label={
            <span className="flex justify-between gap-2">
              {t("branch.purposeLabel")}
              <span className="font-tg-mono text-tg-xs font-normal text-tg-subtle">{t("branch.purposeCount", { count: charCount(purpose.trim()), limit: maxPurpose })}</span>
            </span>
          }
          rows={2}
          value={purpose}
          placeholder={t("branch.purposePlaceholder")}
          error={purposeError}
          onChange={(event) => setOwnPurpose(event.target.value)}
        />
      ) : (
        <PurposeSummary purpose={purpose} onEdit={() => setPurposeOpen(true)} />
      )}
      <KindRadio value={kind} onValueChange={setKind} kinds={kinds} />
      {!seed && <ModelField parent={parentModel} isParentMain={isParentMain} options={modelOptions} value={model} onValueChange={setModel} />}
      {!seed && <LaterField count={later} checked={includeLater} onCheckedChange={setIncludeLater} />}
      {memoryOn && !seed && <LazyBranchMemoryRecall purpose={purpose} onChange={setRemembered} />}
      <PackEstimate lineId={line.id} kind={kind} messages={messages} anchorMessageId={anchorId} purpose={purpose} excerpt={background} includeLater={!seed && includeLater && later > 0} />
      {full && <Alert tone="warning">{t("branch.errorBranchLimit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT })}</Alert>}
      {failure && (
        <FailureAlert
          failure={failure.kind}
          message={describeBranchError(failure.error, t, hostErrorText).message}
          onConfirmDeeper={() => void submit(lastSend, true)}
          onReanchor={
            lastId && !seed
              ? () => {
                  setAnchorId(lastId);
                  setFailure(null);
                }
              : undefined
          }
        />
      )}
      <span className="text-tg-xs text-tg-subtle">
        {t("branch.limitNote", { open: load.openUnderParent, openLimit: BRANCH_OPEN_PER_PARENT_LIMIT, total: load.total, treeLimit: BRANCH_TREE_LIMIT })}
      </span>
    </DialogContent>
  );
}

function FailureAlert({ failure, message, onConfirmDeeper, onReanchor }: { failure: OpenBranchFailure; message: string; onConfirmDeeper: () => void; onReanchor: (() => void) | undefined }) {
  const t = useP1T();
  switch (failure.kind) {
    case "depth":
      return (
        <Alert tone="warning">
          <span className="flex-[1_1_14rem]">{message}</span>
          <Button size="sm" onClick={onConfirmDeeper}>
            {t("branch.depthConfirm")}
          </Button>
        </Alert>
      );
    case "anchorGone":
      return (
        <Alert tone="destructive">
          <span className="flex-[1_1_14rem]">{t("branch.anchorGone")}</span>
          {onReanchor && (
            <Button size="sm" onClick={onReanchor}>
              {t("branch.reanchor")}
            </Button>
          )}
        </Alert>
      );
    case "model":
      return <Alert tone="destructive">{t("branch.errorModel")}</Alert>;
    case "featureOff":
      return <Alert tone="destructive">{t("branch.errorFeatureOff")}</Alert>;
    case "branchLimit":
    case "treeLimit":
      return <Alert tone="warning">{message}</Alert>;
    default:
      return <Alert tone="destructive">{message}</Alert>;
  }
}

/**
 * Open a branch (A3; components.md w 560, field gap 16): purpose (required,
 * prefilled from a selection or a suggestion), kind, provider / model, "also
 * bring what came after", an estimate of the background, and the server's
 * refusals — a deeper branch to confirm, the per-line and per-tree limits, a
 * fork point that moved away (re-anchor on the last message). An accepted AI
 * suggestion is named only while its purpose and kind are unchanged.
 */
export function OpenBranchDialog({ open, onOpenChange, request, ...rest }: OpenBranchDialogProps) {
  return (
    <Dialog open={open && request !== null} onOpenChange={(next) => onOpenChange(next)}>
      {request && <OpenBranchForm key={JSON.stringify(request)} request={request} onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
