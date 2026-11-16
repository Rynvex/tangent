/**
 * F14 ImportFileChips: the drop area with the loaded files as capsules (name,
 * source, how many conversations, remove) and 「加入檔案」 to add more. A file
 * dragged over turns the area primary and dashed ("放開以加入 n 個檔案");
 * a file that cannot be read keeps its capsule (in the error tone) and an
 * alert, the others stay.
 */
import { Button, ErrorAlert } from "@tangent/react";
import { FileJson, FileText, LoaderCircle, Plus, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";
import type { PoolFile } from "./use-import-pool";

const ACCEPT = ".json,.html,.htm,.md,.markdown,.txt,application/json,text/html,text/markdown,text/plain";
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export interface FileChipsProps {
  files: readonly PoolFile[];
  touch: boolean;
  onAdd: (files: readonly File[]) => void;
  onRemove: (id: number) => void;
}

function Chip({ file, touch, onRemove }: { file: PoolFile; touch: boolean; onRemove: () => void }) {
  const t = useF14T();
  const Icon = /\.(md|markdown|txt)$/i.test(file.name) ? FileText : FileJson;
  const failed = file.status === "failed";
  return (
    <li className={cx("inline-flex max-w-full items-center gap-1.5 rounded-tg-sm border pl-2 text-tg-xs", touch ? "h-9" : "h-7.5", failed ? "border-tg-destructive bg-tg-destructive-soft" : "border-tg-border-input bg-tg-surface")}>
      {file.status === "reading" ? <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-tg-muted" /> : <Icon aria-hidden className="size-3.5 shrink-0 text-tg-muted" />}
      <span className="min-w-0 truncate font-tg-mono font-medium text-tg-foreground">{file.name}</span>
      <span className="shrink-0 text-tg-muted">
        {file.status === "reading" ? t("import.fileReading") : file.parsed ? t("import.fileMeta", { source: t(`import.source.${file.parsed.source}`), n: file.parsed.conversations.length }) : size(file.size)}
      </span>
      <button
        type="button"
        aria-label={t("import.removeFile", { name: file.name })}
        onClick={onRemove}
        className={cx("grid shrink-0 place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:size-11", touch ? "size-8" : "size-5.5")}
      >
        <X aria-hidden className="size-3.5" />
      </button>
    </li>
  );
}

/** The alert of a file that failed (the others stay loaded). */
function FileFailure({ file, loaded, onRemove }: { file: PoolFile; loaded: number; onRemove: () => void }) {
  const t = useF14T();
  const text = file.error === "tooLarge" ? t("import.fileTooLarge", { name: file.name }) : file.error === "read" ? t("import.fileFailed", { name: file.name, reason: file.reason }) : t("import.fileUnreadable", { name: file.name, n: loaded });
  return (
    <ErrorAlert>
      <span>{text}</span>
      <Button size="sm" variant="ghost" className="self-start" onClick={onRemove}>
        {t("import.remove")}
      </Button>
    </ErrorAlert>
  );
}

export function FileChips({ files, touch, onAdd, onRemove }: FileChipsProps) {
  const t = useF14T();
  const input = useRef<HTMLInputElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  // A removed capsule took focus with it: 加入檔案 gets it.
  const remove = (id: number) => {
    onRemove(id);
    requestAnimationFrame(() => add.current?.focus());
  };
  const [dragging, setDragging] = useState(0);
  const loaded = files.filter((file) => file.status === "ready").length;
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(0);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length > 0) onAdd(dropped);
  };
  return (
    <>
      <div
        data-tg-drop=""
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(Math.max(event.dataTransfer.items?.length ?? 1, 1));
        }}
        onDragLeave={(event) => {
          // Moving between the area's own children is not leaving it.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(0);
        }}
        onDrop={onDrop}
        className={cx("flex flex-col gap-2 rounded-tg border border-dashed px-3 py-2.5", dragging ? "border-tg-primary bg-tg-primary-soft" : "border-tg-border-strong bg-tg-surface-sunken")}
      >
        {dragging > 0 ? (
          <p role="status" className="m-0 py-3 text-center text-tg-sm font-medium text-tg-primary-text">
            {t("import.dropActive", { n: dragging })}
            {files.length > 0 && <span className="block text-tg-xs font-normal text-tg-muted">{t("import.dropKeep")}</span>}
          </p>
        ) : (
          <>
            {files.length > 0 && (
              <ul aria-label={t("import.files")} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {files.map((file) => (
                  <Chip key={file.id} file={file} touch={touch} onRemove={() => remove(file.id)} />
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button ref={add} size="sm" variant={files.length > 0 ? "ghost" : "secondary"} icon={<Plus aria-hidden className="size-3.5" />} onClick={() => input.current?.click()} className={cx(files.length > 0 && "border border-dashed border-tg-border-strong")}>
                {files.length > 0 ? t("import.addFile") : t("import.chooseFiles")}
              </Button>
              <span className="text-tg-xs text-tg-muted">{touch ? t("import.dropHintShort") : t("import.dropHint")}</span>
            </div>
          </>
        )}
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        aria-hidden
        tabIndex={-1}
        data-tg-import-files=""
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          event.target.value = "";
          if (chosen.length > 0) onAdd(chosen);
        }}
      />
      <span role="status" className="sr-only">
        {files.filter((file) => file.parsed).map((file) => `${file.name}：${t("import.fileMeta", { source: t(`import.source.${file.parsed!.source}`), n: file.parsed!.conversations.length })}`).join("；")}
      </span>
      {files
        .filter((file) => file.status === "failed")
        .map((file) => (
          <FileFailure key={file.id} file={file} loaded={loaded} onRemove={() => remove(file.id)} />
        ))}
    </>
  );
}
