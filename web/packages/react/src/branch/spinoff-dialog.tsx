import {
  charCount,
  chatMessages,
  describeBranchError,
  isFeatureOn,
  spinoffModes,
  type LineView,
  type Message,
  type SpinoffInput,
  type SpinoffMode,
  type SpinoffPreview,
} from "@tangent/client";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useAcceptRebalance, useSpinoff, useSpinoffPreview } from "../data/p1-hooks";
import { useCapabilities, useLine } from "../data/queries";
import { useP1T } from "../i18n/p1-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";
import { ErrorAlert } from "./error-alert";

/** The new conversation's title: at most this many characters (the server's title limit). */
const TITLE_MAX = 200;

export interface SpinoffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line to spin off from (an open branch can go whole; any line can start fresh from a message). */
  line: LineView;
  /** That line's messages. */
  messages: readonly Message[];
  /** Where a fresh conversation starts; "" offers only the whole branch. */
  atMessageId: string;
  /** Accepting a tree-balance suggestion (B4): the whole branch, through `POST /suggestions/{id}/accept`. */
  suggestionId?: string;
  onDone: (result: { line: LineView }) => void;
}

function ModeChoice({ modes, value, onChange, freshFromLast }: { modes: readonly SpinoffMode[]; value: SpinoffMode; onChange: (mode: SpinoffMode) => void; freshFromLast: boolean }) {
  const t = useP1T();
  const label = (mode: SpinoffMode) => (mode === "detach" ? t("spinoff.detach") : freshFromLast ? t("spinoff.freshLast") : t("spinoff.freshHere"));
  const help = (mode: SpinoffMode) => (mode === "detach" ? t("spinoff.detachHelp") : t("spinoff.freshHelp"));
  return (
    <div role="radiogroup" aria-label={t("spinoff.modeLabel")} className="grid grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))] gap-2">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => onChange(mode)}
          className={cx(
            "flex flex-col gap-1 rounded-tg border px-3 py-2.5 text-left text-tg-foreground transition-colors duration-(--tg-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
            mode === value ? "border-2 border-tg-primary bg-tg-primary-soft" : "border-tg-border bg-tg-surface hover:bg-tg-surface-raised",
          )}
        >
          <span className="text-tg-sm font-semibold">{label(mode)}</span>
          <span className="text-tg-xs text-tg-muted">{help(mode)}</span>
        </button>
      ))}
    </div>
  );
}

interface CapsuleProps {
  preview: { data: SpinoffPreview | undefined; isPending: boolean; error: unknown };
  /** detach: the messages that move with the branch (not in the capsule). */
  moved: number | null;
}

/** What the new conversation starts with: the server's own capsule (B8.2 preview), its tokens and limit, the text on demand. */
function Capsule({ preview, moved }: CapsuleProps) {
  const t = useP1T();
  const { hostErrorText } = useTangent();
  const headingId = useId();
  const textId = useId();
  const [open, setOpen] = useState(false);
  const data = preview.data;
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-border px-3 py-2.5">
      <span id={headingId} className="flex justify-between gap-2 text-tg-sm font-medium text-tg-foreground">
        {t("spinoff.capsule")}
        {data && <span className="font-tg-mono text-tg-xs font-normal text-tg-muted">{t("spinoff.capsuleTotal", { tokens: data.capsule.tokenEstimate })}</span>}
      </span>
      {preview.isPending && !preview.error && <span className="text-tg-xs text-tg-muted">{t("spinoff.capsuleLoading")}</span>}
      {preview.error ? <span className="text-tg-xs text-tg-warning">{t("spinoff.capsuleFailed", { reason: describeError(preview.error, t, hostErrorText) })}</span> : null}
      {moved !== null && <span className="text-tg-xs text-tg-muted">{t("spinoff.row.moved", { count: moved })}</span>}
      {data && data.notesToCopy > 0 && <span className="text-tg-xs text-tg-muted">{t("spinoff.notesToCopy", { count: data.notesToCopy })}</span>}
      {data?.capsule.truncated && <span className="text-tg-xs text-tg-warning">{t("spinoff.truncated")}</span>}
      {data && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? textId : undefined}
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-0.5 self-start text-tg-xs text-tg-muted hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
        >
          {open ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
          {open ? t("spinoff.capsuleHide") : t("spinoff.capsuleShow")}
        </button>
      )}
      {data && open && (
        // Scrolls when long, so it takes focus to be scrolled from the keyboard (axe scrollable-region-focusable).
        <pre id={textId} tabIndex={0} aria-label={t("spinoff.capsule")} className="m-0 max-h-60 overflow-auto rounded-tg-sm bg-tg-surface-sunken px-2.5 py-2 font-tg-mono text-tg-xs whitespace-pre-wrap text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
          {data.capsule.text}
        </pre>
      )}
    </div>
  );
}

/** The form; mounted while the dialog is open, so every opening starts fresh. */
function SpinoffForm({ line, messages, atMessageId, suggestionId, onOpenChange, onDone }: Omit<SpinoffDialogProps, "open">) {
  const t = useP1T();
  const { hostErrorText } = useTangent();
  const branch = line.conversationBranch;
  const root = branch?.rootLineId ?? line.id;
  const capabilities = useCapabilities();
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const spin = useSpinoff(line.id, root);
  const accept = useAcceptRebalance(root);
  const modes = suggestionId ? (["detach"] as SpinoffMode[]) : spinoffModes({ branchStatus: branch?.status ?? null, kind: branch?.kind ?? null, atMessageId });
  const [mode, setMode] = useState<SpinoffMode>(modes[0] ?? "fresh");
  const [title, setTitle] = useState(branch?.purpose || line.title);
  const [copyNotes, setCopyNotes] = useState(false);
  const write = suggestionId ? accept : spin;
  // 「來自：…」 names the source: a detached branch's parent, or this line for a fresh start.
  const parent = useLine(branch && mode === "detach" ? branch.parentLineId : null);
  const sourceTitle = branch && mode === "detach" ? (parent.data?.title ?? "") : line.title;
  const previewInput: SpinoffInput = { mode, ...(mode === "fresh" ? { atMessageId } : {}), ...(copyNotes ? { copyNotes: true } : {}) };
  const preview = useSpinoffPreview(line.id, previewInput);
  const tooLong = charCount(title.trim()) > TITLE_MAX;
  const lastId = chatMessages(messages).at(-1)?.id;
  const options = { ...(title.trim() ? { title: title.trim() } : {}), ...(copyNotes ? { copyNotes: true } : {}) };
  const done = (created: LineView) => {
    onOpenChange(false);
    onDone({ line: created });
  };
  const submit = () => {
    if (tooLong || write.isPending) return;
    if (suggestionId) {
      accept.mutate({ suggestionId, body: { action: "spinoff", ...options } }, { onSuccess: ({ result }) => result && done(result.line) });
      return;
    }
    spin.mutate({ mode, ...(mode === "fresh" ? { atMessageId } : {}), ...options }, { onSuccess: (result) => done(result.line) });
  };
  return (
    <DialogContent
      width="md"
      title={
        <span className="inline-flex items-center gap-2">
          <ExternalLink aria-hidden className="size-4.5 text-tg-primary-text" />
          {t("spinoff.title")}
        </span>
      }
      description={branch?.purpose || line.title}
      footer={
        <>
          <DialogClose render={<Button>{t("branch.cancel")}</Button>} />
          <Button variant="primary" loading={write.isPending} onClick={submit}>
            {t("spinoff.submit")}
          </Button>
        </>
      }
    >
      {modes.length > 1 && <ModeChoice modes={modes} value={mode} onChange={setMode} freshFromLast={atMessageId === lastId} />}
      <TextField label={t("spinoff.titleLabel")} value={title} error={tooLong ? t("spinoff.titleTooLong", { limit: TITLE_MAX }) : null} onChange={(event) => setTitle(event.target.value)} />
      <Capsule preview={preview} moved={mode === "detach" ? chatMessages(messages).length : null} />
      {notesOn && (
        <Checkbox checked={copyNotes} onCheckedChange={setCopyNotes}>
          {t("spinoff.copyNotes")}
        </Checkbox>
      )}
      <span className="text-tg-xs text-tg-muted">{t("spinoff.links", { title: sourceTitle })}</span>
      {write.error && <ErrorAlert>{describeBranchError(write.error, t, hostErrorText).message}</ErrorAlert>}
    </DialogContent>
  );
}

/**
 * 獨立成新對話 (B2; prototype dialog, w 560): the whole open branch (with its
 * messages and branches) or a fresh conversation from a message; the new
 * conversation's title; its origin capsule as the server would build it
 * (B8.2 preview: text, tokens, whether it was cut, how many notes would be
 * copied); whether to copy the notes. The source keeps
 * a 「已獨立 →」 link and the new one shows 「來自：…」. Through a tree-balance
 * suggestion it accepts the suggestion with `{action: "spinoff"}`.
 */
export function SpinoffDialog({ open, onOpenChange, ...rest }: SpinoffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <SpinoffForm onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
