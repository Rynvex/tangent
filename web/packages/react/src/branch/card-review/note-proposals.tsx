import { useDialogT } from "../../i18n/dialog-messages";
import { NOTE_CHANGES_MAX, NOTE_SECTIONS, type Note, type NoteProposal, type NoteSection } from "@tangent/client";
import { NotebookPen, X } from "lucide-react";
import { useRef } from "react";
import { Button } from "../../components/button";
import { Checkbox } from "../../components/checkbox";
import { IconButton } from "../../components/icon-button";
import { Select } from "../../components/select";
import { TextArea } from "../../components/text-field";
import { cx } from "../../lib/cx";
import { SECTION_KEYS } from "../note-sections";

export interface NoteProposalsProps {
  rows: readonly NoteProposal[];
  onChange: (rows: NoteProposal[]) => void;
  /** The tree's notes (lines a proposal may replace). */
  notes: readonly Note[];
}

function Row({ row, notes, patch, remove }: { row: NoteProposal; notes: readonly Note[]; patch: (change: Partial<NoteProposal>) => void; remove: () => void }) {
  const t = useDialogT();
  const sections = NOTE_SECTIONS.map((value) => ({ value, label: t(SECTION_KEYS[value]) }));
  const old = row.op === "supersede" ? notes.find((note) => note.id === row.noteId) : undefined;
  return (
    <div data-proposal="" className={cx("flex flex-col gap-2 rounded-tg-sm border bg-tg-surface p-2.5", row.ai ? "border-dashed border-tg-suggestion" : "border-tg-border")}>
      <div className="flex items-center gap-2">
        <Checkbox checked={row.included} onCheckedChange={(included) => patch({ included })} aria-label={t("review.noteInclude")} />
        <span className="flex-1 text-tg-xs font-medium text-tg-muted">{row.op === "add" ? t("review.noteOpAdd") : t("review.noteOpReplace")}</span>
        {row.ai && <span className="text-tg-xs text-tg-suggestion">{t("review.noteFromAi")}</span>}
        <IconButton label={t("review.remove")} icon={<X />} size="sm" tooltip={false} onClick={remove} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Select label={t("review.noteSection")} options={sections} value={row.section} onValueChange={(section: NoteSection) => patch({ section })} />
        {row.op === "supersede" && (
          <Select
            label={t("review.noteTarget")}
            options={notes.map((note) => ({ value: note.id, label: note.text }))}
            value={row.noteId || null}
            onValueChange={(noteId) => patch({ noteId, section: notes.find((note) => note.id === noteId)?.section ?? row.section })}
            className="min-w-0 flex-1"
          />
        )}
      </div>
      {old && <p className="m-0 rounded-tg-sm bg-tg-destructive-soft px-2 py-1.5 text-tg-sm text-tg-muted line-through">{old.text}</p>}
      <TextArea label={t("review.noteText")} rows={2} value={row.text} onChange={(event) => patch({ text: event.target.value })} />
    </div>
  );
}

/**
 * "Changes to the notes" (A5, notes feature): lines to add or to replace,
 * written in the same request as the card. "Accept all" applies every row;
 * "bring back with ticked changes" only the ticked ones. The draft's own
 * proposals (B5) come in ticked, dashed and marked as the AI's.
 */
export function NoteProposals({ rows, onChange, notes }: NoteProposalsProps) {
  const t = useDialogT();
  const counter = useRef(0);
  const replaceable = notes.filter((note) => note.status !== "superseded");
  const add = (op: NoteProposal["op"]) => {
    counter.current += 1;
    const target = replaceable[0];
    onChange([...rows, { key: `proposal-${counter.current}`, op, included: true, section: op === "supersede" ? (target?.section ?? "decided") : "decided", text: "", noteId: op === "supersede" ? (target?.id ?? "") : "" }]);
  };
  const full = rows.length >= NOTE_CHANGES_MAX;
  return (
    <section className="flex flex-col gap-2 border-t border-tg-border pt-3.5">
      <span className="inline-flex items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
        <NotebookPen aria-hidden className="size-3.5" />
        {t("review.notesTitle")}
      </span>
      <span className="text-tg-xs text-tg-muted">{t("review.notesHelp", { max: NOTE_CHANGES_MAX })}</span>
      {rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          notes={replaceable}
          patch={(change) => onChange(rows.map((item) => (item.key === row.key ? { ...item, ...change } : item)))}
          remove={() => onChange(rows.filter((item) => item.key !== row.key))}
        />
      ))}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" aria-disabled={full || undefined} onClick={() => !full && add("add")}>
          {t("review.noteAdd")}
        </Button>
        {replaceable.length > 0 && (
          <Button size="sm" aria-disabled={full || undefined} onClick={() => !full && add("supersede")}>
            {t("review.noteReplace")}
          </Button>
        )}
      </div>
    </section>
  );
}
