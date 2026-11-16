import { useDialogT } from "../i18n/dialog-messages";
import { asideAnswer, NOTE_SECTIONS, NOTE_TEXT_MAX, noteDraft, validateNote, type BranchView, type Message, type NoteSection, type NoteWriteResult } from "@tangent/client";
import { useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { Select } from "../components/select";
import { describeError } from "../conversation/error-text";
import { TextArea } from "../components/text-field";
import { useCreateNote } from "../data/note-mutations";
import { useTangent } from "../provider";
import { ErrorAlert } from "./error-alert";
import { SECTION_KEYS } from "./note-sections";

export interface AsideNoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The aside whose answer is kept. */
  branch: BranchView;
  /** The aside's messages (its answer is the last finished reply). */
  messages: readonly Message[];
  onSaved: (result: NoteWriteResult) => void;
}

function AsideNoteBody({ branch, messages, onOpenChange, onSaved }: Omit<AsideNoteDialogProps, "open">) {
  const t = useDialogT();
  const { hostErrorText } = useTangent();
  const create = useCreateNote(branch.rootLineId);
  const answer = asideAnswer(messages);
  const [text, setText] = useState(() => noteDraft(answer?.content ?? ""));
  const [section, setSection] = useState<NoteSection>("fact");
  const [tried, setTried] = useState(false);
  const problem = validateNote(text);
  const save = () => {
    setTried(true);
    if (problem || create.isPending) return;
    create.mutate(
      { section, text: text.trim(), sourceLineId: branch.lineId, ...(answer ? { sourceMessageId: answer.id } : {}) },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          onSaved(result);
        },
      },
    );
  };
  const error = tried && problem === "empty" ? t("asideNote.empty") : problem === "tooLong" ? t("asideNote.tooLong", { max: NOTE_TEXT_MAX }) : null;
  return (
    <DialogContent
      width="md"
      title={t("asideNote.title")}
      description={t("asideNote.body")}
      footer={
        <>
          <DialogClose render={<Button>{t("branch.cancel")}</Button>} />
          <Button variant="primary" loading={create.isPending} onClick={save}>
            {t("asideNote.save")}
          </Button>
        </>
      }
    >
      <Select label={t("review.noteSection")} options={NOTE_SECTIONS.map((value) => ({ value, label: t(SECTION_KEYS[value]) }))} value={section} onValueChange={setSection} />
      <TextArea label={t("asideNote.text")} rows={4} value={text} error={error} onChange={(event) => setText(event.target.value)} />
      {create.error && <ErrorAlert>{t("asideNote.failed", { reason: describeError(create.error, t, hostErrorText) })}</ErrorAlert>}
    </DialogContent>
  );
}

/**
 * Keep an aside's answer (A4 "順口問保存"): asides are cleared after 7 days,
 * so the answer can go into the notes (default "confirmed facts") with the
 * aside as its source. Shown only when the notes feature is on.
 */
export function AsideNoteDialog({ open, onOpenChange, ...rest }: AsideNoteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {open && <AsideNoteBody onOpenChange={onOpenChange} {...rest} />}
    </Dialog>
  );
}
