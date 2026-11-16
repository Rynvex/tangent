import { NOTE_SECTIONS, type NoteSection } from "@tangent/client";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { SegmentedControl } from "../components/segmented-control";
import { describeError } from "../conversation/error-text";
import { useCreateNote } from "../data/note-mutations";
import { useTangent, useUiT } from "../provider";
import { SECTION_KEYS } from "../branch/note-sections";
import { NoteEditor } from "./note-editor";

export interface NoteAddFormProps {
  lineId: string;
  maxRunes: number;
  /** The line the note comes from (focus mode: the node it is written on). */
  sourceLineId?: string;
  /** The section chosen first (facts by default; to-confirm on a node, FOCUS_MODE.md §8.2). */
  defaultSection?: NoteSection;
  /** Closed: added (true) or cancelled (false). */
  onDone: (added: boolean) => void;
}

/** The prototype's inline form: the section (facts first), one line of text, Enter or 加入 adds it; Esc cancels. */
export function NoteAddForm({ lineId, maxRunes, sourceLineId, defaultSection = "fact", onDone }: NoteAddFormProps) {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const headingId = useId();
  const create = useCreateNote(lineId);
  const [section, setSection] = useState<NoteSection>(defaultSection);
  const add = (text: string) => {
    if (create.isPending) return;
    create.mutate({ section, text, ...(sourceLineId ? { sourceLineId } : {}) }, { onSuccess: () => onDone(true) });
  };
  return (
    <div role="group" aria-labelledby={headingId} className="flex flex-col gap-2 rounded-tg-sm border border-tg-ring bg-tg-surface-raised p-2.5">
      <span id={headingId} className="sr-only">
        {t("notes.addTitle")}
      </span>
      <SegmentedControl label={t("notes.section")} options={NOTE_SECTIONS.map((value) => ({ value, label: t(SECTION_KEYS[value]) }))} value={section} onValueChange={setSection} />
      <NoteEditor
        label={t("notes.textLabel")}
        initial=""
        placeholder={t("notes.placeholder")}
        maxRunes={maxRunes}
        error={create.error ? t("notes.failed", { reason: describeError(create.error, t, hostErrorText) }) : null}
        onSubmit={add}
        onCancel={() => onDone(false)}
        actions={(submit) => (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onDone(false)}>
              {t("notes.cancel")}
            </Button>
            <Button size="sm" variant="primary" loading={create.isPending} onClick={submit}>
              {t("notes.submit")}
            </Button>
          </div>
        )}
      />
    </div>
  );
}
