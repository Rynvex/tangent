/**
 * Settings → Archive (G2): every archived conversation in one place, with a
 * search, 解除封存 and 永久刪除 (asked a second time in the row, since the
 * whole tree goes for good). The same `GET /lines?archived=true` the
 * conversation list's bottom section reads.
 */
import type { LineView } from "@tangent/client";
import { Button, describeError, Skeleton, useArchiveLine, useDeleteLine, useLines, useReadOnly, useTangent, useUiT } from "@tangent/react";
import { ArchiveRestore, Search, Trash2 } from "lucide-react";
import { useContext, useId, useState } from "react";
import { matchesSearch } from "./list-model";
import { HighlightContext, RowNote, SettingsGroup } from "./settings-controls";
import { useSettingsT } from "./settings-messages";

export interface ArchivePanelProps {
  /** Shows a conversation (the dialog closes). */
  onOpen?: ((lineId: string) => void) | undefined;
}

type Notice = { tone: "status" | "alert"; text: string } | null;

function archivedDate(iso: string | null, locale: string): string {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" }).format(at) : "";
}

interface ArchivedRowProps {
  line: LineView;
  readOnly: boolean;
  onOpen: ArchivePanelProps["onOpen"];
  onNotice: (notice: Notice) => void;
}

function ArchivedRow({ line, readOnly, onOpen, onNotice }: ArchivedRowProps) {
  const t = useSettingsT();
  const ui = useUiT();
  const { hostErrorText, locale } = useTangent();
  const archive = useArchiveLine();
  const remove = useDeleteLine();
  const [asking, setAsking] = useState(false);
  const title = line.title || ui("shell.untitled");
  const busy = archive.isPending || remove.isPending;
  const failed = (error: unknown) => onNotice({ tone: "alert", text: t("g2.archive.failed", { reason: describeError(error, ui, hostErrorText) }) });
  const date = archivedDate(line.archivedAt, locale);
  return (
    <li data-archived={line.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
      <span className="flex min-w-40 flex-1 flex-col">
        {onOpen ? (
          <button type="button" onClick={() => onOpen(line.id)} className="self-start truncate text-left text-tg-sm font-medium text-tg-foreground-strong underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
            {title}
          </button>
        ) : (
          <span className="truncate text-tg-sm font-medium text-tg-foreground-strong">{title}</span>
        )}
        {date && <span className="text-tg-xs text-tg-subtle">{t("g2.archive.archivedAt", { date })}</span>}
      </span>
      {!readOnly &&
        (asking ? (
          <span role="group" aria-label={t("g2.archive.deleteLabel", { title })} className="flex flex-wrap items-center gap-2">
            <span className="text-tg-xs text-tg-destructive">{t("g2.archive.deleteAsk")}</span>
            <Button size="sm" autoFocus onClick={() => setAsking(false)}>
              {t("g2.archive.deleteNo")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              loading={remove.isPending}
              // A promise, not the mutation's callbacks: the row is gone by the time it settles.
              onClick={() => void remove.mutateAsync(line.id).then(() => onNotice({ tone: "status", text: t("g2.archive.deleted", { title }) }), (error: unknown) => (setAsking(false), failed(error)))}
            >
              {t("g2.archive.deleteYes")}
            </Button>
          </span>
        ) : (
          <>
            <Button
              size="sm"
              aria-label={t("g2.archive.restoreLabel", { title })}
              icon={<ArchiveRestore aria-hidden className="size-3.5" />}
              loading={archive.isPending}
              disabled={busy}
              onClick={() => void archive.mutateAsync({ lineId: line.id, archived: false }).then(() => onNotice({ tone: "status", text: t("g2.archive.restored", { title }) }), failed)}
            >
              {t("g2.archive.restore")}
            </Button>
            <Button size="sm" variant="ghost" aria-label={t("g2.archive.deleteLabel", { title })} icon={<Trash2 aria-hidden className="size-3.5" />} disabled={busy} onClick={() => setAsking(true)}>
              {t("g2.archive.delete")}
            </Button>
          </>
        ))}
    </li>
  );
}

export function ArchivePanel({ onOpen }: ArchivePanelProps) {
  const t = useSettingsT();
  const ui = useUiT();
  const readOnly = useReadOnly();
  const archived = useLines({ archived: true });
  const highlighted = useContext(HighlightContext) === "archive";
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const all = archived.data?.lines ?? [];
  const shown = query.trim() ? all.filter((line) => matchesSearch(line, query)) : all;
  return (
    <div data-setting="archive" data-highlighted={highlighted || undefined} className="flex flex-col gap-4">
      <label htmlFor={searchId} className="flex h-(--tg-control-height) items-center gap-2 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.5 text-tg-subtle focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-tg-ring">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("g2.archive.search")}
          placeholder={t("g2.archive.search")}
          className="min-w-0 flex-1 border-0 bg-transparent text-tg-sm text-tg-foreground outline-none placeholder:text-tg-subtle"
        />
      </label>
      {readOnly && <RowNote>{t("g2.archive.readOnly")}</RowNote>}
      {/* Always mounted, so a restore or delete is announced. */}
      <div role={notice?.tone === "alert" ? "alert" : "status"} className={notice ? undefined : "sr-only"}>
        {notice && <RowNote tone={notice.tone === "alert" ? "destructive" : "muted"}>{notice.text}</RowNote>}
      </div>
      <SettingsGroup title={t("g2.archive")} note={t("g2.archive.desc")}>
        {archived.isPending && <Skeleton className="m-4 h-10" />}
        {archived.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-2 px-4 py-3 text-tg-sm text-tg-muted">
            {t("g2.archive.loadFailed")}
            <Button size="sm" onClick={() => void archived.refetch()}>
              {ui("shell.retry")}
            </Button>
          </div>
        )}
        {archived.isSuccess && shown.length === 0 && <p className="m-0 px-4 py-3 text-tg-sm text-tg-muted">{all.length === 0 ? t("g2.archive.empty") : t("g2.archive.noMatch", { query: query.trim() })}</p>}
        {shown.length > 0 && (
          <ul className="m-0 flex list-none flex-col divide-y divide-tg-border p-0">
            {shown.map((line) => (
              <ArchivedRow key={line.id} line={line} readOnly={readOnly} onOpen={onOpen} onNotice={setNotice} />
            ))}
          </ul>
        )}
      </SettingsGroup>
    </div>
  );
}
