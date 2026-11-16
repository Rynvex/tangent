import { BRANCH_PURPOSE_MAX, chatNumbers, classifyAttachError, previewLine, type AttachLineInput, type AttachLineResult, type LineView, type Message } from "@tangent/client";
import { GitBranchPlus } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "../branch/error-alert";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { Select } from "../components/select";
import { TextArea, TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useAttachLine } from "../data/b18-hooks";
import { useLines } from "../data/queries";
import { useAttachT } from "../i18n/attach-messages";
import { useTangent, useUiT } from "../provider";

/** The conversation to attach, when the caller already knows it (a related line). */
export interface AttachSource {
  lineId: string;
  title: string;
}

export interface AttachLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line the other conversation will hang on. */
  line: LineView;
  /** Its messages (the anchors to choose from). */
  messages: readonly Message[];
  /** The main line of `line`'s conversation (it cannot be attached into itself). */
  rootLineId: string;
  /** The conversation to attach; null lets the user pick one of the loaded main lines. */
  source: AttachSource | null;
  onAttached: (result: AttachLineResult, source: AttachSource) => void;
}

type Mode = "merged" | "open";
const AUTO = "auto";

const anchorable = (message: Message) => message.status === "done" && (message.role === "user" || message.role === "assistant" || message.kind === "branch_card");

function useAttachError(error: unknown): string | null {
  const t = useAttachT();
  const ui = useUiT();
  const { hostErrorText } = useTangent();
  if (!error) return null;
  const failure = classifyAttachError(error);
  switch (failure.kind) {
    case "deeper":
      return t("attach.error.deeper", { depth: failure.depth });
    case "invalidCard":
      return t("attach.error.invalidCard", { reason: describeError(error, ui, hostErrorText) });
    case "other":
      return t("attach.error.other", { reason: describeError(error, ui, hostErrorText) });
    default:
      return t(`attach.error.${failure.kind}`);
  }
}

/** The loaded main lines that could be attached: not this conversation, not archived. */
function useCandidates(rootLineId: string, enabled: boolean): readonly LineView[] {
  const lines = useLines({}, enabled);
  return useMemo(() => (lines.data?.lines ?? []).filter((line) => line.id !== rootLineId && !line.conversationBranch && !line.archivedAt), [lines.data, rootLineId]);
}

function AttachBody({ line, messages, rootLineId, source, onOpenChange, onAttached }: Omit<AttachLineDialogProps, "open">) {
  const t = useAttachT();
  const ui = useUiT();
  const modeName = useId();
  const hintId = useId();
  const attach = useAttachLine(line.id);
  const candidates = useCandidates(rootLineId, source === null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const pickedLine = candidates.find((item) => item.id === picked);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((item) => item.id === picked || (item.title || item.id).toLowerCase().includes(q));
  }, [candidates, picked, search]);
  const chosen: AttachSource | null = source ?? (pickedLine ? { lineId: pickedLine.id, title: pickedLine.title } : null);
  const numbers = useMemo(() => chatNumbers(messages), [messages]);
  const anchors = useMemo(() => messages.filter(anchorable), [messages]);
  const [anchor, setAnchor] = useState<string>(AUTO);
  const [purpose, setPurpose] = useState("");
  const [mode, setMode] = useState<Mode>("merged");
  const [conclusion, setConclusion] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirmDeeper, setConfirmDeeper] = useState(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const conclusionField = useRef<HTMLTextAreaElement>(null);
  const purposeField = useRef<HTMLInputElement>(null);
  const errorText = useAttachError(attach.error);
  const failure = attach.error ? classifyAttachError(attach.error) : null;
  const deeper = failure?.kind === "deeper";
  const who = (message: Message) => t(message.kind === "branch_card" ? "attach.who.card" : message.role === "user" ? "attach.who.user" : "attach.who.assistant");
  const label = (message: Message) => `${numbers.has(message.id) ? `#${numbers.get(message.id)} ` : ""}${who(message)}：${previewLine(message)}`;
  const conclusionMissing = mode === "merged" && conclusion.trim() === "";
  const purposeTooLong = Array.from(purpose.trim()).length > BRANCH_PURPOSE_MAX;

  const submit = (deep = confirmDeeper) => {
    setTouched(true);
    if (attach.isPending || !chosen) return;
    // A blocked submit takes focus to what blocks it (its error is described there).
    if (purposeTooLong) return purposeField.current?.focus();
    if (conclusionMissing) return conclusionField.current?.focus();
    const input: AttachLineInput = {
      sourceLineId: chosen.lineId,
      ...(anchor !== AUTO ? { anchorMessageId: anchor } : {}),
      ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      status: mode,
      ...(mode === "merged" ? { card: { conclusion: conclusion.trim() } } : {}),
      ...(deep ? { confirmDeeper: true } : {}),
    };
    // The promise, not mutate's callbacks: those are dropped if the host unmounts while the tree reloads.
    attach
      .mutateAsync(input)
      .then((result) => {
        onOpenChange(false);
        onAttached(result, chosen);
      })
      .catch(() => undefined); // the refusal shows in the dialog (attach.error)
  };

  return (
    <DialogContent
      width="md"
      title={
        <span className="inline-flex items-center gap-2">
          <GitBranchPlus aria-hidden className="size-4.5 text-tg-primary-text" />
          {t("attach.title")}
        </span>
      }
      description={t("attach.sub")}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-3">
          <DialogClose render={<Button variant="ghost">{t("attach.cancel")}</Button>} />
          <Button
            ref={submitButton}
            variant="primary"
            icon={<GitBranchPlus aria-hidden className="size-3.5" />}
            loading={attach.isPending}
            loadingText={t("attach.submitting")}
            aria-disabled={!chosen || undefined}
            onClick={() => submit()}
          >
            {t("attach.submit")}
          </Button>
        </div>
      }
    >
      {source ? (
        <dl className="m-0 flex flex-col gap-1.5">
          <dt className="text-tg-sm font-medium text-tg-foreground">{t("attach.source")}</dt>
          <dd data-tg-attach-source="" className="m-0 rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 text-tg-sm text-tg-foreground-strong">
            {source.title}
          </dd>
        </dl>
      ) : candidates.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {candidates.length > 3 && <TextField label={t("attach.sourceSearch")} value={search} onChange={(event) => setSearch(event.target.value)} />}
          <Select label={t("attach.source")} placeholder={t("attach.sourcePick")} options={filtered.map((item) => ({ value: item.id, label: item.title || item.id }))} value={picked} onValueChange={setPicked} />
          {touched && !chosen && (
            <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
              {t("attach.sourcePick")}
            </p>
          )}
        </div>
      ) : (
        <p className="m-0 text-tg-sm text-tg-muted">{t("attach.sourceNone")}</p>
      )}
      <div className="flex flex-col gap-1">
        <Select
          label={t("attach.anchor")}
          options={[{ value: AUTO, label: t("attach.anchorAuto") }, ...anchors.map((message) => ({ value: message.id, label: label(message) }))]}
          value={anchor}
          onValueChange={setAnchor}
        />
        <p className="m-0 text-tg-xs text-tg-muted">{t("attach.anchorHint")}</p>
      </div>
      <TextField
        ref={purposeField}
        label={t("attach.purpose")}
        value={purpose}
        placeholder={chosen?.title ?? ""}
        description={t("attach.purposeHint")}
        error={purposeTooLong ? ui("branch.purposeTooLong", { limit: BRANCH_PURPOSE_MAX }) : null}
        onChange={(event) => setPurpose(event.target.value)}
      />
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 p-0 text-tg-sm font-medium text-tg-foreground">{t("attach.mode")}</legend>
        {(["merged", "open"] as const).map((value) => (
          <label key={value} className="flex cursor-pointer items-start gap-2 rounded-tg-sm border border-tg-border px-2.5 py-2 has-checked:border-tg-primary has-checked:bg-tg-primary-soft">
            <input
              type="radio"
              name={modeName}
              value={value}
              aria-describedby={`${hintId}-${value}`}
              checked={mode === value}
              onChange={() => setMode(value)}
              className="mt-0.5 size-4 shrink-0 accent-tg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
            />
            <span className="flex flex-col">
              <span className="text-tg-sm font-medium text-tg-foreground">{t(`attach.mode.${value}`)}</span>
              <span id={`${hintId}-${value}`} aria-hidden className="text-tg-xs text-tg-muted">
                {t(`attach.mode.${value}Hint`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {mode === "merged" && (
        <TextArea
          ref={conclusionField}
          label={t("attach.conclusion")}
          value={conclusion}
          rows={3}
          required
          error={touched && conclusionMissing ? t("attach.conclusionRequired") : failure?.kind === "invalidCard" ? errorText : null}
          onChange={(event) => setConclusion(event.target.value)}
        />
      )}
      {errorText && (
        <ErrorAlert tone={deeper ? "warning" : "destructive"}>
          <span>{errorText}</span>
          {deeper && (
            <Button
              size="sm"
              className="self-start"
              onClick={() => {
                // The alert goes while the attach runs: focus stays in the dialog, on its submit.
                submitButton.current?.focus();
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
 * F15 併為此對話的支線 (w560; full screen on phones): another conversation of
 * the tenant, with its whole tree, hangs on this line as a branch (B20). By
 * default it arrives brought back, with a conclusion card at the end of the
 * line; or it stays open. The anchor is picked by time unless chosen.
 */
export function AttachLineDialog({ open, onOpenChange, ...rest }: AttachLineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <AttachBody key={rest.source?.lineId ?? "pick"} onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}

export default AttachLineDialog;
