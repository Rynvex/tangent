/**
 * F14 step 1 of the import dialog (S1): paste text or upload one or more
 * exports, then search and check the conversations to put together. With one
 * checked, 快速匯入單篇 goes to F13's single-conversation form; with one or
 * more, 下一步 arranges them by time.
 */
import { selectionSummary, type DuplicateOf, type TimelineSession } from "@tangent/client";
import { Button, ErrorAlert, SegmentedControl, TextArea } from "@tangent/react";
import { ArrowRight, ClipboardPaste, Files, ListChecks } from "lucide-react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";
import { FileChips } from "./file-chips";
import { SessionPicker } from "./session-picker";
import { yearDay, dayOf } from "./time-format";
import type { ImportPool } from "./use-import-pool";

export type SourceTab = "file" | "paste";

export interface PickStepProps {
  pool: ImportPool;
  tab: SourceTab;
  onTab: (tab: SourceTab) => void;
  sessions: readonly TimelineSession[];
  duplicates: ReadonlyMap<string, DuplicateOf>;
  picked: readonly string[];
  query: string;
  touch: boolean;
  locale: string;
  onQuery: (query: string) => void;
  onToggle: (key: string) => void;
  onPickAll: (keys: readonly string[]) => void;
  onSetTime: (key: string, manualTime: string | null) => void;
  onCancel: () => void;
  onQuick: () => void;
  onNext: () => void;
}

function PickFooter({ props }: { props: PickStepProps }) {
  const t = useF14T();
  const chosen = props.sessions.filter((session) => props.picked.includes(session.key));
  const summary = selectionSummary(chosen);
  const range = summary.from && summary.to ? { from: yearDay(Date.parse(summary.from)), to: dayOf(Date.parse(summary.to)) } : null;
  const note = chosen.length === 0 ? t("import.noneSelected") : range ? t("import.selectedSummary", { n: summary.count, m: summary.messages, ...range }) : t("import.selectedNoRange", { n: summary.count, m: summary.messages });
  const single = chosen.length === 1;
  return (
    <div className={cx("flex shrink-0 gap-3 border-t border-tg-border bg-tg-surface-sunken", props.touch ? "flex-col px-4 pt-2.5 pb-4" : "items-center px-5 py-3")}>
      <p role="status" className="m-0 flex min-w-0 flex-1 items-start gap-1.5 text-tg-xs text-tg-foreground">
        <ListChecks aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tg-muted" />
        {note}
      </p>
      <div className={cx("flex gap-2", props.touch ? "flex-col-reverse" : "shrink-0 items-center")}>
        <Button variant="ghost" onClick={props.onCancel} className={cx(props.touch && "h-11")}>
          {t("import.cancel")}
        </Button>
        <Button aria-disabled={!single || undefined} title={single ? undefined : t("import.quickSingleOff")} onClick={() => single && props.onQuick()} className={cx(props.touch && "h-11")}>
          {t("import.quickSingle")}
        </Button>
        <Button variant="primary" icon={<ArrowRight aria-hidden className="size-3.5" />} aria-disabled={chosen.length === 0 || undefined} title={chosen.length === 0 ? t("import.nextOff") : undefined} onClick={() => chosen.length > 0 && props.onNext()} className={cx(props.touch && "h-11")}>
          {props.touch ? t("import.nextShort") : t("import.next")}
        </Button>
      </div>
    </div>
  );
}

export function PickStep(props: PickStepProps) {
  const t = useF14T();
  const { pool, tab, touch } = props;
  const rows = props.sessions.map((session) => ({ session, duplicate: props.duplicates.get(session.key) ?? null }));
  const failure = tab === "paste" && pool.pastedFailure && pool.pastedFailure !== "empty" ? pool.pastedFailure : null;
  return (
    <>
      <div className={cx("flex min-h-0 flex-1 flex-col gap-3 overflow-auto", touch ? "px-4 py-3" : "px-5 py-4")}>
        <SegmentedControl<SourceTab>
          label={t("import.source")}
          value={tab}
          onValueChange={props.onTab}
          className="w-full [&>button]:flex-1"
          options={[
            { value: "paste", label: <span className="inline-flex items-center gap-1.5"><ClipboardPaste aria-hidden className="size-3.5" />{touch ? t("import.pasteTabShort") : t("import.pasteTab")}</span> },
            { value: "file", label: <span className="inline-flex items-center gap-1.5"><Files aria-hidden className="size-3.5" />{touch ? t("import.multiTabShort") : t("import.multiTab")}</span> },
          ]}
        />
        {tab === "paste" ? (
          <TextArea label={t("import.pasteLabel")} value={pool.pastedText} rows={touch ? 5 : 6} placeholder={t("import.pastePlaceholder")} onChange={(event) => pool.setPastedText(event.target.value)} inputClassName="font-tg-mono text-tg-xs" />
        ) : (
          <FileChips files={pool.files} touch={touch} onAdd={pool.addFiles} onRemove={pool.removeFile} />
        )}
        {failure && <ErrorAlert>{t("import.fileUnreadable", { name: t("import.pasted"), n: pool.files.filter((file) => file.status === "ready").length })}</ErrorAlert>}
        {rows.length > 0 && (
          <SessionPicker
            rows={rows}
            picked={new Set(props.picked)}
            query={props.query}
            searchable={rows.length >= 2 || pool.files.length >= 2}
            fileCount={pool.files.length + (pool.pastedText.trim() ? 1 : 0)}
            touch={touch}
            locale={props.locale}
            onQuery={props.onQuery}
            onToggle={props.onToggle}
            onPickAll={props.onPickAll}
            onSetTime={props.onSetTime}
          />
        )}
      </div>
      <PickFooter props={props} />
    </>
  );
}
