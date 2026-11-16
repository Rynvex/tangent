/**
 * F14 SessionPicker: every conversation of the loaded files (and the pasted
 * text), newest first. With two or more, a search over titles and first
 * prompts ("符合 n / total 篇", 全選符合的; a title hit is highlighted, a
 * first-prompt hit is shown under the title). Each row: a checkbox (the
 * whole row toggles it), its TimeBadge, title, source and size. One already
 * imported is flagged and left unchecked (decision #10).
 */
import { matchSession, sessionTimes, type DuplicateOf, type SessionMatch, type TimelineSession } from "@tangent/client";
import { Checkbox } from "@tangent/react";
import { ListChecks, Search, TriangleAlert } from "lucide-react";
import { useId, type MouseEvent } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";
import { SessionTime } from "./time-badge";
import { yearDay } from "./time-format";

export interface PickerRow {
  session: TimelineSession;
  duplicate: DuplicateOf | null;
}

export interface SessionPickerProps {
  rows: readonly PickerRow[];
  picked: ReadonlySet<string>;
  query: string;
  /** Show the search (two or more conversations, or several files). */
  searchable: boolean;
  fileCount: number;
  touch: boolean;
  locale: string;
  onQuery: (query: string) => void;
  onToggle: (key: string) => void;
  onPickAll: (keys: readonly string[]) => void;
  onSetTime: (key: string, manualTime: string | null) => void;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const at = query.trim() ? text.toLowerCase().indexOf(query.trim().toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  const end = at + query.trim().length;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[0.125rem] bg-tg-highlight px-0.5 text-inherit">{text.slice(at, end)}</mark>
      {text.slice(end)}
    </>
  );
}

function Row({ row, match, query, checked, touch, locale, onToggle, onSetTime }: { row: PickerRow; match: SessionMatch; query: string; checked: boolean; touch: boolean; locale: string; onToggle: () => void; onSetTime: (value: string | null) => void }) {
  const t = useF14T();
  const { session, duplicate } = row;
  const duplicateId = useId();
  const conversation = session.conversation;
  const stats = [t("import.rowStat", { n: conversation.messages.length }), conversation.branches.length > 0 ? t("import.rowRegen", { n: conversation.branches.length }) : null, sessionTimes(session).kind === "file" ? t("import.rowNoTime") : null].filter(Boolean).join("・");
  // The row toggles its checkbox, except from its own buttons (the time badge).
  const onRowClick = (event: MouseEvent<HTMLLIElement>) => {
    // Clicks in the time popover reach here through React's tree (it is portaled): only the row itself toggles.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).closest("button, [role=checkbox], input, a")) return;
    onToggle();
  };
  return (
    <li onClick={onRowClick} data-tg-session-row={session.key} className={cx("flex cursor-pointer items-center gap-3 border-b border-tg-border px-3 last:border-b-0 hover:bg-tg-accent", touch ? "min-h-16 py-2" : "min-h-11 py-1.5")}>
      <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={conversation.title || t("import.untitled")} aria-describedby={duplicate ? duplicateId : undefined} className={touch ? "size-5.5" : undefined} />
      {!touch && <SessionTime session={session} variant="start" touch={touch} locale={locale} onApply={onSetTime} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cx("min-w-0 truncate text-tg-sm font-medium", checked ? "text-tg-foreground-strong" : "text-tg-foreground")}>
            {match.inTitle ? <Highlight text={conversation.title || t("import.untitled")} query={query} /> : conversation.title || t("import.untitled")}
          </span>
          <span className="shrink-0 rounded-tg-full border border-tg-border px-1.5 text-tg-xs text-tg-muted">{session.fileName ? t(`import.source.${session.source}`) : t("import.pasted")}</span>
          {touch && <SessionTime session={session} variant="start" touch={touch} locale={locale} onApply={onSetTime} />}
        </span>
        {match.prompt && (
          <span className="truncate text-tg-xs text-tg-muted">
            {t("import.promptMatch")}
            {match.prompt.before}
            <mark className="rounded-[0.125rem] bg-tg-highlight px-0.5 text-inherit">{match.prompt.hit}</mark>
            {match.prompt.after}
          </span>
        )}
        {duplicate && (
          <span id={duplicateId} data-tg-duplicate="" className="inline-flex items-center gap-1 text-tg-xs text-tg-foreground">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-tg-warning" />
            {duplicate.folder
              ? t("import.duplicate", { title: duplicate.title, date: duplicate.date ? yearDay(Date.parse(duplicate.date)) : "", folder: duplicate.folder })
              : t("import.duplicateNoFolder", { title: duplicate.title, date: duplicate.date ? yearDay(Date.parse(duplicate.date)) : "" })}
          </span>
        )}
      </div>
      <span className="shrink-0 text-right text-tg-xs text-tg-muted">{stats}</span>
    </li>
  );
}

export function SessionPicker({ rows, picked, query, searchable, fileCount, touch, locale, onQuery, onToggle, onPickAll, onSetTime }: SessionPickerProps) {
  const t = useF14T();
  const matched = rows.flatMap((row) => {
    const match = matchSession(row.session.conversation, query);
    return match ? [{ row, match }] : [];
  });
  // Newest first, so the latest are easy to find (S2 turns it oldest first); those without a time last.
  const ordered = [...matched].sort((a, b) => (sessionTimes(b.row.session).start ?? -Infinity) - (sessionTimes(a.row.session).start ?? -Infinity));
  return (
    <section aria-label={t("import.listLabel")} className="flex min-h-0 flex-col gap-2">
      {searchable && (
        <div className="flex items-stretch gap-2">
          <label className={cx("flex min-w-0 flex-1 items-center gap-2 rounded-tg border border-tg-border-input bg-tg-surface px-2.5 focus-within:outline-2 focus-within:outline-tg-ring", touch ? "h-11" : "h-9")}>
            <Search aria-hidden className="size-4 shrink-0 text-tg-muted" />
            <input type="search" aria-label={t("import.searchLabel")} placeholder={t("import.searchLabel")} value={query} onChange={(event) => onQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-tg-sm text-tg-foreground outline-none" />
            <span role="status" className="shrink-0 font-tg-mono text-tg-xs text-tg-muted">
              {touch ? t("import.searchHitsShort", { n: matched.length, total: rows.length }) : t("import.searchHits", { n: matched.length, total: rows.length })}
            </span>
          </label>
          <button
            type="button"
            onClick={() => onPickAll(ordered.map((item) => item.row.session.key))}
            disabled={ordered.length === 0}
            className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-tg border border-tg-border-input bg-tg-surface px-3 text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45", touch ? "h-11" : "h-9")}
          >
            <ListChecks aria-hidden className="size-4" />
            {touch ? t("import.selectMatchesShort") : t("import.selectMatches")}
          </button>
        </div>
      )}
      {ordered.length === 0 && query.trim() ? (
        <p className="m-0 rounded-tg border border-tg-border bg-tg-surface px-3 py-6 text-center text-tg-sm text-tg-muted">{t("import.noResults", { files: fileCount, q: query.trim() })}</p>
      ) : (
        <ul className="m-0 min-h-0 flex-1 list-none overflow-auto rounded-tg border border-tg-border bg-tg-surface p-0">
          {ordered.map(({ row, match }) => (
            <Row
              key={row.session.key}
              row={row}
              match={match}
              query={query}
              checked={picked.has(row.session.key)}
              touch={touch}
              locale={locale}
              onToggle={() => onToggle(row.session.key)}
              onSetTime={(value) => onSetTime(row.session.key, value)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
