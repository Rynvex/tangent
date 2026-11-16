import {
  BRANCH_PURPOSE_MAX,
  chatNumbers,
  classifyExtractError,
  classifyOpenBranchError,
  describeBranchError,
  defaultExtractEnd,
  estimateTokens,
  EXTRACT_MAX_MESSAGES,
  extractAnchor,
  extractEndChoices,
  extractStart,
  firstSentence,
  previewLine,
  summarizeTopic,
  validatePurpose,
  type BranchView,
  type ExtractBranchInput,
  type ExtractBranchResult,
  type LineView,
  type Message,
} from "@tangent/client";
import { useQueryClient } from "@tanstack/react-query";
import { Scissors } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ErrorAlert } from "../branch/error-alert";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { SegmentedControl } from "../components/segmented-control";
import { Select } from "../components/select";
import { TextArea, TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useExtractBranch } from "../data/b18-hooks";
import { useF13T } from "../i18n/f13-messages";
import { useTangent, useUiT } from "../provider";

export interface ExtractPrefill {
  toMessageId?: string;
  purpose?: string;
  conclusion?: string;
}

export interface ExtractBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line the messages leave. */
  line: LineView;
  messages: readonly Message[];
  /** The tree's outline: a merged branch whose card stays on this line protects its anchor. */
  branches: readonly BranchView[];
  /** Messages that start a chapter (the end stops before them). */
  cutMessageIds?: ReadonlySet<string>;
  /** The message whose 「⋯」 opened it; a reply moves the start up to its question. */
  triggerMessageId: string;
  /** A decompose detour's end, purpose and conclusion. */
  prefill?: ExtractPrefill;
  /** The range's message ids as they change (the host outlines them), `[]` when it closes. */
  onRangeChange?: (messageIds: readonly string[]) => void;
  onExtracted: (result: ExtractBranchResult) => void;
}

type MovableKind = "investigate" | "alternative";
/** A card's question is the range's first question, flattened and kept short. */
const QUESTION_RUNES = 300;
const flatCut = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return Array.from(flat).length <= max ? flat : `${Array.from(flat).slice(0, max - 1).join("")}…`;
};

function useExtractError(error: unknown): string | null {
  const t = useF13T();
  const ui = useUiT();
  const { hostErrorText } = useTangent();
  if (!error) return null;
  const failure = classifyExtractError(error);
  switch (failure.kind) {
    case "notUserStart":
    case "noAnchor":
    case "protected":
    case "busy":
    case "archived":
    case "closed":
      return t(`extract.error.${failure.kind}`);
    case "count":
      return t("extract.error.count", { max: failure.max });
    case "invalidCard":
      return t("extract.error.invalidCard", { reason: describeError(error, ui, hostErrorText) });
    default:
      return t("extract.error.other", { reason: describeError(error, ui, hostErrorText) });
  }
}

function ExtractBody({ line, messages, branches, cutMessageIds, triggerMessageId, prefill, onRangeChange, onOpenChange, onExtracted }: Omit<ExtractBranchDialogProps, "open">) {
  const t = useF13T();
  const ui = useUiT();
  const { keys } = useTangent();
  const queryClient = useQueryClient();
  const extract = useExtractBranch(line.id);
  const numbers = useMemo(() => chatNumbers(messages), [messages]);
  const start = useMemo(() => extractStart(messages, triggerMessageId, branches), [messages, triggerMessageId, branches]);
  const choices = useMemo(() => (start.startId && !start.problem ? extractEndChoices(messages, start.startId, branches, cutMessageIds) : []), [messages, start, branches, cutMessageIds]);
  const startMessage = messages.find((message) => message.id === start.startId) ?? null;
  const [chosenEnd, setChosenEnd] = useState<string | null>(prefill?.toMessageId ?? null);
  // A refused range shrinks back to what the line allows now (the choices follow the refetched messages).
  const end = choices.find((message) => message.id === chosenEnd) ?? defaultExtractEnd(choices);
  const range = end ? choices.slice(0, choices.indexOf(end) + 1) : [];
  const anchor = start.startId ? extractAnchor(messages, start.startId) : null;
  const [purpose, setPurpose] = useState(() => prefill?.purpose ?? summarizeTopic(startMessage?.content ?? ""));
  const [kind, setKind] = useState<MovableKind>("investigate");
  const [mergeNow, setMergeNow] = useState(true);
  const lastReply = [...range].reverse().find((message) => message.role === "assistant");
  // Until the user writes their own, the conclusion follows the chosen end (the prefill belongs to its own end).
  const [written, setConclusion] = useState<string | null>(null);
  const conclusion = written ?? (prefill?.conclusion !== undefined && end?.id === prefill.toMessageId ? prefill.conclusion : firstSentence(lastReply?.content ?? ""));
  const [touched, setTouched] = useState(false);
  const [confirmDeeper, setConfirmDeeper] = useState(false);
  const errorText = useExtractError(extract.error);
  const depth = extract.error ? classifyOpenBranchError(extract.error).kind === "depth" : false;

  const rangeKey = range.map((message) => message.id).join(",");
  useEffect(() => {
    onRangeChange?.(rangeKey ? rangeKey.split(",") : []);
  }, [rangeKey, onRangeChange]);
  useEffect(() => () => onRangeChange?.([]), [onRangeChange]);

  const purposeProblem = validatePurpose(purpose);
  const problem = start.problem ?? (range.length < 2 ? "single" : null);
  const conclusionMissing = mergeNow && conclusion.trim() === "";
  const blocked = problem !== null || line.status === "thinking";
  const number = (message: Message | null | undefined) => (message ? (numbers.get(message.id) ?? 0) : 0);
  const who = (message: Message) => t(message.role === "user" ? "extract.who.user" : "extract.who.assistant");
  const label = (message: Message) => `#${number(message)} ${who(message)}：${previewLine(message)}`;
  const saved = range.reduce((sum, message) => sum + estimateTokens(message.content), 0) - (mergeNow ? estimateTokens(conclusion) : 0);

  const submit = (deeper = confirmDeeper) => {
    setTouched(true);
    if (blocked || purposeProblem || conclusionMissing || !start.startId || !end || extract.isPending) return;
    const input: ExtractBranchInput = {
      fromMessageId: start.startId,
      toMessageId: end.id,
      purpose: purpose.trim(),
      kind,
      ...(mergeNow ? { card: { question: flatCut(startMessage?.content ?? purpose, QUESTION_RUNES), conclusion: conclusion.trim() } } : {}),
      ...(deeper ? { confirmDeeper: true } : {}),
    };
    // The promise, not mutate's callbacks: those are dropped if the host unmounts while the lines reload.
    extract.mutateAsync(input).then(
      (result) => {
        onOpenChange(false);
        onExtracted(result);
      },
      (error: unknown) => {
        // The line changed under the dialog: read it again so the end can only be what is allowed now.
        const code = classifyExtractError(error).kind;
        if (code === "protected" || code === "notUserStart" || code === "noAnchor") void queryClient.invalidateQueries({ queryKey: keys.messages(line.id) });
      },
    );
  };

  const purposeError = touched && purposeProblem === "required" ? t("extract.purposeRequired") : purposeProblem === "tooLong" ? t("extract.purposeTooLong", { limit: BRANCH_PURPOSE_MAX }) : null;
  return (
    <DialogContent
      width="md"
      title={
        <span className="inline-flex items-center gap-2">
          <Scissors aria-hidden className="size-4.5 text-tg-primary-text" />
          {t("extract.title", { n: number(startMessage) || number(messages.find((message) => message.id === triggerMessageId)) })}
        </span>
      }
      description={t("extract.sub")}
      footer={
        <div className="flex w-full flex-wrap items-center gap-3">
          {range.length > 1 && <span className="mr-auto text-tg-xs text-tg-muted">{t("extract.saving", { n: range.length, tokens: Math.max(0, saved).toLocaleString() })}</span>}
          <DialogClose render={<Button variant="ghost">{t("extract.cancel")}</Button>} />
          <Button
            variant="primary"
            icon={<Scissors aria-hidden className="size-3.5" />}
            loading={extract.isPending}
            aria-disabled={blocked || undefined}
            onClick={() => submit()}
          >
            {extract.isPending ? t("extract.submitting") : mergeNow ? t("extract.submitCard") : t("extract.submit")}
          </Button>
        </div>
      }
    >
      {problem && <ErrorAlert tone="warning">{t(`extract.problem.${problem}`)}</ErrorAlert>}
      {start.aligned && !start.problem && <p className="m-0 text-tg-xs text-tg-muted">{t("extract.aligned", { n: number(startMessage) })}</p>}
      {!start.problem && (
        <section aria-labelledby="tg-extract-range" className="flex flex-col gap-2">
          <h3 id="tg-extract-range" className="m-0 text-tg-sm font-medium text-tg-foreground">
            {t("extract.range")}
          </h3>
          <div className="grid grid-cols-[2.5rem_1fr] items-center gap-x-2 gap-y-2">
            <span className="text-tg-sm text-tg-muted">{t("extract.from")}</span>
            <p aria-label={t("extract.from")} className="m-0 flex h-(--tg-control-height) min-w-0 items-center truncate rounded-tg-sm bg-tg-surface-sunken px-2.5 text-tg-sm text-tg-muted">
              {startMessage ? label(startMessage) : ""}
            </p>
            <span className="text-tg-sm text-tg-muted">{t("extract.to")}</span>
            <Select
              aria-label={t("extract.to")}
              options={choices.map((message) => ({ value: message.id, label: label(message) }))}
              value={end?.id ?? null}
              onValueChange={setChosenEnd}
              className="min-w-0"
            />
          </div>
          <p className="m-0 text-tg-xs text-tg-muted">
            {range.length > 1
              ? t("extract.summary", { n: range.length, a: number(anchor), from: number(range[0]), to: number(range.at(-1)) })
              : t("extract.summaryOne", { a: number(anchor) })}
          </p>
          <p className="m-0 text-tg-xs text-tg-subtle">{t("extract.boundary", { max: EXTRACT_MAX_MESSAGES })}</p>
        </section>
      )}
      <div className="grid gap-3 sm:grid-cols-[11.25rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <span className="text-tg-sm font-medium text-tg-foreground">{t("extract.kind")}</span>
          <SegmentedControl<MovableKind>
            label={t("extract.kind")}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "investigate", label: ui("branch.kindInvestigate") },
              { value: "alternative", label: ui("branch.kindAlternative") },
            ]}
          />
        </div>
        <TextField label={t("extract.purpose")} value={purpose} error={purposeError} onChange={(event) => setPurpose(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Checkbox checked={mergeNow} onCheckedChange={setMergeNow}>
          <span className="font-medium">{t("extract.mergeNow")}</span>
        </Checkbox>
        {!mergeNow && <p className="m-0 pl-6 text-tg-xs text-tg-muted">{t("extract.leaveMarker", { n: range.length })}</p>}
      </div>
      {mergeNow && (
        <TextArea
          className="pl-6"
          label={t("extract.conclusion", { n: range.length })}
          value={conclusion}
          rows={3}
          error={touched && conclusionMissing ? t("extract.conclusionRequired") : null}
          description={lastReply ? t("extract.conclusionHint", { n: number(lastReply) }) : undefined}
          onChange={(event) => setConclusion(event.target.value)}
        />
      )}
      {errorText && (
        <ErrorAlert tone={depth ? "warning" : "destructive"}>
          <span>{depth ? describeBranchError(extract.error, ui).message : errorText}</span>
          {depth && (
            <Button
              size="sm"
              className="self-start"
              onClick={() => {
                setConfirmDeeper(true);
                submit(true);
              }}
            >
              {ui("branch.depthConfirm")}
            </Button>
          )}
        </ErrorAlert>
      )}
    </DialogContent>
  );
}

/**
 * F13 S3 抽成支線 (w560; full screen on phones): any stretch of a line, the
 * middle included, into a branch. The start is fixed (a reply's opens at its
 * question); the end runs up to the next boundary; by default the branch is
 * brought back at once and a conclusion card stays in the range's place.
 */
export function ExtractBranchDialog({ open, onOpenChange, ...rest }: ExtractBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <ExtractBody key={`${rest.triggerMessageId}:${rest.prefill?.toMessageId ?? ""}`} onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}

export default ExtractBranchDialog;
