import {
  branchesToMarkdown,
  branchesToMermaid,
  branchesToOpml,
  downloadText,
  exportFileName,
  exportScope,
  flashcardCounts,
  flashcardsMarkdown,
  flashcardsTsv,
  treeAdrMarkdown,
  treeBackupJson,
  treeFlashcards,
  treeReportMarkdown,
  truncatedLines,
  type BranchView,
  type Flashcard,
  type TreeExport,
} from "@tangent/client";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  ExportPreview,
  outlineExportLabels,
  SegmentedControl,
  Select,
  useExportT,
  useTreeExport,
  useTreeExportLabels,
  type ExportMessageKey,
} from "@tangent/react";
import { CircleAlert, Copy, Download, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type ExportFormat = "outlineMarkdown" | "outlineMermaid" | "outlineOpml" | "report" | "backup" | "adr" | "cards";
type CardsFile = "handout" | "anki";
type Translate = ReturnType<typeof useExportT>;

/** The formats, grouped by use (F8 §0 #13): the outline needs no export call; the others read the whole tree. */
const GROUPS: ReadonlyArray<{ label: ExportMessageKey; formats: ReadonlyArray<{ id: ExportFormat; label: ExportMessageKey }> }> = [
  {
    label: "export.groupOutline",
    formats: [
      { id: "outlineMarkdown", label: "export.outlineMarkdown" },
      { id: "outlineMermaid", label: "export.outlineMermaid" },
      { id: "outlineOpml", label: "export.outlineOpml" },
    ],
  },
  {
    label: "export.groupFull",
    formats: [
      { id: "report", label: "export.report" },
      { id: "backup", label: "export.backup" },
    ],
  },
  { label: "export.groupProject", formats: [{ id: "adr", label: "export.adr" }] },
  { label: "export.groupLearning", formats: [{ id: "cards", label: "export.cards" }] },
];
const FORMATS = GROUPS.flatMap((group) => group.formats);
const DESCRIPTIONS: Record<ExportFormat, ExportMessageKey> = {
  outlineMarkdown: "export.describeOutline",
  outlineMermaid: "export.describeOutline",
  outlineOpml: "export.describeOutline",
  report: "export.describeReport",
  backup: "export.describeBackup",
  adr: "export.describeAdr",
  cards: "export.describeCards",
};
const isOutline = (format: ExportFormat) => format.startsWith("outline");
const COPIED_MS = 1500;

export interface ExportFile {
  name: string;
  mime: string;
  text: string;
}

type Download = (fileName: string, mime: string, text: string) => void;

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootLineId: string;
  /** The line on screen; any line of the tree reads the same export. */
  lineId: string;
  /** The conversation's title (file names, the dialog's title). */
  title: string;
  /** The tree's outline (the outline formats). */
  outline: readonly BranchView[];
  /** Defaults to a browser download; tests pass a spy. */
  download?: Download;
}

interface Options {
  includeMemos: boolean;
  includeEnded: boolean;
}

/** The file a full format makes from the export; exactly what the preview shows. */
function fullFile(format: ExportFormat, tree: TreeExport, cards: readonly Flashcard[], cardsFile: CardsFile, options: Options, title: string, labels: ReturnType<typeof useTreeExportLabels>, t: Translate): ExportFile {
  switch (format) {
    case "backup":
      return { name: exportFileName(title, "json"), mime: "application/json", text: treeBackupJson(tree) };
    case "adr":
      return { name: exportFileName(`ADR ${title}`, "md"), mime: "text/markdown", text: treeAdrMarkdown(tree, labels) };
    case "cards":
      return cardsFile === "anki"
        ? { name: exportFileName(`${title} ${t("export.cards")}`, "tsv"), mime: "text/tab-separated-values", text: flashcardsTsv(cards) }
        : { name: exportFileName(`${title} ${t("export.cards")}`, "md"), mime: "text/markdown", text: flashcardsMarkdown(cards, labels, title) };
    default:
      return { name: exportFileName(title, "md"), mime: "text/markdown", text: treeReportMarkdown(tree, labels, options) };
  }
}

function outlineFile(format: ExportFormat, title: string, outline: readonly BranchView[], t: Translate): ExportFile {
  const labels = outlineExportLabels(t);
  if (format === "outlineMermaid") return { name: exportFileName(title, "mmd"), mime: "text/plain", text: branchesToMermaid(title, outline, labels) };
  if (format === "outlineOpml") return { name: exportFileName(title, "opml"), mime: "text/x-opml", text: branchesToOpml(title, outline, labels) };
  return { name: exportFileName(title, "md"), mime: "text/markdown", text: branchesToMarkdown(title, outline, labels) };
}

/** The format list (≥ 640px): one radio group, arrows move and choose, the groups' names in between. */
function FormatList({ value, onChange, t }: { value: ExportFormat; onChange: (format: ExportFormat) => void; t: Translate }) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = FORMATS.findIndex((format) => format.id === value);
    const next = FORMATS[(index + step + FORMATS.length) % FORMATS.length]!.id;
    onChange(next);
    list.current?.querySelector<HTMLElement>(`[data-format="${next}"]`)?.focus();
  };
  return (
    <div ref={list} role="radiogroup" aria-label={t("export.formats")} onKeyDown={onKeyDown} className="hidden w-60 shrink-0 flex-col gap-0.5 overflow-auto border-r border-tg-border p-2 sm:flex">
      {GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <span aria-hidden className="px-2.5 pt-2.5 pb-1 text-tg-xs font-medium text-tg-subtle">
            {t(group.label)}
          </span>
          {group.formats.map((format) => (
            <button
              key={format.id}
              type="button"
              role="radio"
              data-format={format.id}
              aria-checked={format.id === value}
              tabIndex={format.id === value ? 0 : -1}
              onClick={() => onChange(format.id)}
              className="flex min-h-8 items-center rounded-tg-sm px-2.5 text-left text-tg-sm text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring aria-checked:bg-tg-accent aria-checked:font-medium aria-checked:shadow-[inset_3px_0_0_var(--tg-primary)] pointer-coarse:min-h-11"
            >
              {t(format.label)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function Banner({ tone, children }: { tone: "warning" | "destructive"; children: ReactNode }) {
  return (
    <div
      role={tone === "destructive" ? "alert" : "status"}
      className={`flex flex-wrap items-center gap-2 rounded-tg-sm border px-3 py-2 text-tg-sm text-tg-foreground ${tone === "warning" ? "border-tg-warning bg-tg-warning-soft" : "border-tg-destructive bg-tg-destructive-soft"}`}
    >
      {tone === "warning" ? <TriangleAlert aria-hidden className="size-4 shrink-0 text-tg-warning" /> : <CircleAlert aria-hidden className="size-4 shrink-0 text-tg-destructive" />}
      {children}
    </div>
  );
}

/** Copy's own short "已複製" / failure state. */
function useCopy(t: Translate) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = (text: string) => {
    const done = (next: "copied" | "failed") => {
      setState(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), COPIED_MS);
    };
    if (!navigator.clipboard) return done("failed");
    navigator.clipboard.writeText(text).then(
      () => done("copied"),
      () => done("failed"),
    );
  };
  const label = state === "copied" ? t("export.copied") : state === "failed" ? t("export.copyFailed") : t("export.copy");
  return { copy, label };
}

/**
 * 匯出 (F8 S9): the outline formats, the full report and backup, an ADR and
 * flashcards. The whole tree (`GET /lines/{id}/export`) is read only once a
 * format needs it; the preview is the file as it downloads. Reading is
 * allowed to viewers too. Its state belongs to one conversation.
 */
export function ExportDialog(props: ExportDialogProps) {
  return <ExportForm key={props.rootLineId} {...props} />;
}

function ExportForm({ open, onOpenChange, lineId, title, outline, download = downloadText }: ExportDialogProps) {
  const t = useExportT();
  const labels = useTreeExportLabels();
  const [format, setFormat] = useState<ExportFormat>("outlineMarkdown");
  const [cardsFile, setCardsFile] = useState<CardsFile>("handout");
  const [options, setOptions] = useState<Options>({ includeMemos: false, includeEnded: true });
  const full = !isOutline(format);
  const tree = useTreeExport(lineId, open && full);
  const copy = useCopy(t);
  const name = title || t("exportDoc.mainLine");
  const data = tree.data;
  const cards = useMemo(() => (data ? treeFlashcards(data) : []), [data]);
  const file = useMemo(() => (!full ? outlineFile(format, name, outline, t) : data ? fullFile(format, data, cards, cardsFile, options, name, labels, t) : null), [full, format, name, outline, t, data, cards, cardsFile, options, labels]);
  const noCards = format === "cards" && data !== undefined && cards.length === 0;
  const ready = file !== null && !noCards;
  const counts = flashcardCounts(cards);
  const lines = data ? truncatedLines(data) : 0;
  const scope = !full ? t("export.scopeOutline", { branches: outline.length }) : data ? t("export.scope", { ...exportScope(data) }) : "";

  const preview = !full ? (
    <ExportPreview mode="text" text={file?.text ?? ""} className="flex-1" />
  ) : tree.isError ? (
    <Banner tone="destructive">
      <span className="min-w-0 flex-1">{t("export.failed")}</span>
      <Button size="sm" onClick={() => void tree.refetch()}>
        {t("export.retry")}
      </Button>
    </Banner>
  ) : !data ? (
    // A still block (the design: the skeleton does not pulse).
    <div role="status" className="flex flex-1 items-start rounded-tg-sm border border-tg-border bg-tg-surface-sunken px-4 py-3.5 text-tg-sm text-tg-muted">
      {t("export.loading")}
    </div>
  ) : noCards ? (
    <p className="m-0 rounded-tg-sm border border-tg-border bg-tg-surface-sunken px-4 py-3.5 text-tg-sm text-tg-muted">{t("export.cardsEmpty")}</p>
  ) : format === "cards" && cardsFile === "handout" ? (
    <ExportPreview mode="cards" cards={cards} className="flex-1" />
  ) : (
    <ExportPreview mode="text" text={file?.text ?? ""} className="flex-1" />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("export.title", { title: name })}
        width="xl"
        padded={false}
        className="sm:h-[calc(100dvh-6rem)]! sm:max-w-[56.25rem]!"
        footer={
          <>
            <span className="mr-auto self-center text-tg-xs text-tg-muted max-sm:w-full">{scope}</span>
            <Button icon={<Copy aria-hidden className="size-3.5" />} disabled={!ready} onClick={() => file && copy.copy(file.text)} className="max-sm:flex-1">
              {copy.label}
            </Button>
            <Button variant="primary" icon={<Download aria-hidden className="size-3.5" />} disabled={!ready} onClick={() => file && download(file.name, file.mime, file.text)} className="max-sm:flex-1">
              {t("export.download")}
            </Button>
          </>
        }
      >
        <div className="flex h-full min-h-0 flex-col sm:flex-row">
          <FormatList value={format} onChange={setFormat} t={t} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-5 py-4">
            <Select label={t("export.formats")} options={FORMATS.map((item) => ({ value: item.id, label: t(item.label) }))} value={format} onValueChange={setFormat} className="sm:hidden" />
            <p className="m-0 text-tg-sm text-tg-muted">{t(DESCRIPTIONS[format])}</p>
            {format === "report" && (
              <fieldset className="m-0 flex flex-wrap gap-x-4 border-0 p-0">
                <legend className="sr-only">{t("export.options")}</legend>
                <Checkbox checked={options.includeMemos} onCheckedChange={(checked) => setOptions({ ...options, includeMemos: checked })}>
                  {t("export.includeMemos")}
                </Checkbox>
                <Checkbox checked={options.includeEnded} onCheckedChange={(checked) => setOptions({ ...options, includeEnded: checked })}>
                  {t("export.includeEnded")}
                </Checkbox>
              </fieldset>
            )}
            {format === "cards" && (
              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl
                  label={t("export.cardsFormat")}
                  options={[
                    { value: "handout" as const, label: t("export.cardsHandout") },
                    { value: "anki" as const, label: t("export.cardsAnki") },
                  ]}
                  value={cardsFile}
                  onValueChange={setCardsFile}
                />
                {data && (
                  <span className="text-tg-xs text-tg-muted">
                    {t("export.cardsCount", { ...counts })}
                    {counts.term > 0 && ` · ${t("export.cardsTerms", { term: counts.term })}`}
                  </span>
                )}
              </div>
            )}
            {full && data?.truncated && <Banner tone="warning">{lines > 0 ? t("export.truncated", { n: lines }) : t("exportDoc.truncated")}</Banner>}
            {preview}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
