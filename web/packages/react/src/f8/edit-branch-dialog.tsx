import { BRANCH_PURPOSE_MAX, charCount, chatNumbers, flowPurpose, forkPointBefore, PURPOSE_PREFILL_CHARS, purposeHead, type LineView, type Message } from "@tangent/client";
import { useRef, useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { TextArea } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useF8T } from "../i18n/f8-messages";
import { useTangent } from "../provider";
import { useBranchAndSend } from "./branch-and-send";

export interface EditBranchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line the message is on (the new branch hangs on it). */
  line: LineView;
  messages: readonly Message[];
  /** The user's message being edited. */
  messageId: string;
  /** The branch is open (and, unless `sendError`, the edited message sent there): the host goes there. */
  onDone: (branchLineId: string, sendError?: string) => void;
}

/**
 * 修改並分岔 (S6, components.md `EditAndBranchDialog`): the original stays,
 * a new alternative branch opens from the message before it (#k-1) and the
 * edited text is its first message (decision #3's anchor rule, so the AI
 * never sees the old question as well). w560, full screen on phones; the
 * text box has focus; nothing to send until the text changes.
 */
export function EditBranchDialog({ open, onOpenChange, ...rest }: EditBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <EditForm key={`${rest.line.id}:${rest.messageId}`} onOpenChange={onOpenChange} {...rest} />
    </Dialog>
  );
}

function EditForm({ line, messages, messageId, onOpenChange, onDone }: Omit<EditBranchDialogProps, "open">) {
  const t = useF8T();
  const { hostErrorText } = useTangent();
  const original = messages.find((message) => message.id === messageId);
  const before = forkPointBefore(messages, messageId);
  const numbers = chatNumbers(messages);
  const [text, setText] = useState(original?.content ?? "");
  const [purpose, setPurpose] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const flow = useBranchAndSend(line.id);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const shownPurpose = purpose ?? flowPurpose(t("edit.purposePrefix", { text: purposeHead(text, PURPOSE_PREFILL_CHARS) }));
  const changed = text.trim() !== "" && text.trim() !== (original?.content ?? "").trim();
  const purposeOk = shownPurpose.trim() !== "" && charCount(shownPurpose.trim()) <= BRANCH_PURPOSE_MAX;
  const submit = () => {
    if (!before || !changed || !purposeOk || flow.pending) return;
    setError(null);
    void flow.run({ anchorMessageId: before.id, purpose: shownPurpose.trim(), kind: "alternative" }, text.trim()).then((result) => {
      if ("created" in result) {
        onOpenChange(false);
        onDone(result.created.line.id);
        return;
      }
      const reason = describeError(result.failure.error, t, hostErrorText);
      if (result.failure.stage === "send") {
        onOpenChange(false);
        onDone(result.failure.created.line.id, t("edit.sendFailed", { reason }));
        return;
      }
      setError(t("edit.failed", { reason }));
    });
  };
  return (
    <DialogContent
      width="md"
      title={t("edit.title")}
      description={before ? t("edit.explain", { k: numbers.get(messageId) ?? "?", a: numbers.get(before.id) ?? "?" }) : t("edit.firstMsg")}
      initialFocus={textBox}
      footer={
        <>
          <DialogClose render={<Button>{t("edit.cancel")}</Button>} />
          <Button variant="primary" loading={flow.pending} aria-disabled={!before || !changed || !purposeOk || undefined} title={!changed ? t("edit.unchanged") : undefined} onClick={submit}>
            {t("edit.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <span className="text-tg-sm font-medium text-tg-foreground">{t("edit.original")}</span>
        <p className="m-0 max-h-28 overflow-y-auto rounded-tg-sm bg-tg-surface-sunken px-3 py-2 text-tg-sm whitespace-pre-wrap text-tg-muted">{original?.content}</p>
      </div>
      <TextArea ref={textBox} label={t("edit.changeTo")} rows={4} value={text} onChange={(event) => setText(event.target.value)} description={!changed ? t("edit.unchanged") : undefined} />
      <TextArea
        label={t("edit.purpose")}
        rows={2}
        value={shownPurpose}
        onChange={(event) => setPurpose(event.target.value)}
        error={!purposeOk ? t("seeds.tooLong", { max: BRANCH_PURPOSE_MAX }) : undefined}
      />
      {error && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-3 py-2 text-tg-sm text-tg-foreground">
          {error}
        </p>
      )}
    </DialogContent>
  );
}
