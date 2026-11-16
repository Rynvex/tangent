import {
  hitPlace,
  isFeatureOn,
  searchLoadedTree,
  TREE_SEARCH_LIMIT,
  TREE_SEARCH_MIN,
  type BranchList,
  type FoldList,
  type MessagePage,
  type SearchHit,
} from "@tangent/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, TextSearch, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { describeError } from "../conversation/error-text";
import { useBranches, useCapabilities } from "../data/queries";
import { useF8T } from "../i18n/f8-messages";
import { cx } from "../lib/cx";
import { useDebounced } from "../lib/use-debounced";
import { useTangent } from "../provider";

/** Wait this long after typing stops before searching (the server, or the cache). */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_STALE_MS = 30_000;

export interface InTreeSearchBarProps {
  rootLineId: string;
  /** The conversation's title (local hits name it like the server's do). */
  rootTitle: string;
  /** Goes to a hit: the line and, for a message, the message (its fold opens, it is highlighted). */
  onJump: (lineId: string, messageId?: string) => void;
  onClose: () => void;
  /** Phones: results fill the message area, and picking one closes them (the bar stays). */
  narrow?: boolean;
  /** Focus inside the bar's box: a second ⌘F there is the browser's (decision #11). */
  onFocusWithin?: (inside: boolean) => void;
  /** Changes when the host asks for the bar again (⌘F with focus elsewhere): the box takes focus. */
  focusToken?: number;
  className?: string;
}

/** The messages and folds of every line of the tree already in the query cache (search off: decision #15). */
function useLoadedTree(rootLineId: string, rootTitle: string, on: boolean, query: string) {
  const { keys } = useTangent();
  const queryClient = useQueryClient();
  const outline = useBranches(rootLineId, true);
  return useMemo(() => {
    const branches = outline.data?.branches ?? [];
    const lineIds = [rootLineId, ...branches.map((branch) => branch.lineId)];
    const messagesByLine = Object.fromEntries(lineIds.flatMap((lineId) => {
      const page = queryClient.getQueryData<MessagePage>(keys.messages(lineId));
      return page ? [[lineId, page.messages] as const] : [];
    }));
    return { tree: { rootLineId, rootTitle, branches, messagesByLine }, on };
    // The cache is read again for each query (and outline), not on every cache write.
  }, [outline.data, rootLineId, rootTitle, queryClient, keys, on, query]);
}

function Snippet({ hit }: { hit: SearchHit }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [index, range] of hit.highlights.entries()) {
    parts.push(hit.snippet.slice(at, range.start));
    parts.push(
      <mark key={index} className="rounded-[2px] bg-tg-highlight text-tg-foreground">
        {hit.snippet.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  }
  parts.push(hit.snippet.slice(at));
  return <span className="line-clamp-2 text-tg-sm break-words text-tg-foreground">{parts}</span>;
}

/**
 * 對話內搜尋 (S3, components.md `InTreeSearchBar` / `InTreeSearchResults`):
 * a bar under the header that searches only this conversation — its branch
 * purposes and every line's messages, folds included — with the server's
 * search (`root`), or, while that feature is off, what is loaded here. Two
 * groups, each hit placed (主線, 支線, 順口問, or 「在折疊 #a–#b 裡」); ↑↓ pick,
 * Enter jumps, Esc closes.
 */
export function InTreeSearchBar({ rootLineId, rootTitle, onJump, onClose, narrow = false, onFocusWithin, focusToken = 0, className }: InTreeSearchBarProps) {
  const t = useF8T();
  const { client, keys, hostErrorText } = useTangent();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const serverOn = isFeatureOn(capabilities.data, "search");
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [resultsOpen, setResultsOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusToken > 0) input.current?.focus();
  }, [focusToken]);
  const q = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const long = Array.from(q).length >= TREE_SEARCH_MIN;
  const server = useQuery({
    queryKey: [...keys.search(q), { root: rootLineId }],
    queryFn: ({ signal }) => client.search({ q, root: rootLineId, limit: TREE_SEARCH_LIMIT }, { signal }),
    enabled: serverOn && long,
    staleTime: SEARCH_STALE_MS,
    retry: false,
  });
  const loaded = useLoadedTree(rootLineId, rootTitle, !serverOn, q);
  const hits = useMemo(() => (!long ? [] : serverOn ? (server.data?.hits ?? []).filter((hit) => hit.kind !== "title") : searchLoadedTree(loaded.tree, q)), [long, serverOn, server.data, loaded, q]);
  const ordered = useMemo(() => [...hits.filter((hit) => hit.kind === "purpose"), ...hits.filter((hit) => hit.kind === "message")], [hits]);
  const current = Math.min(active, Math.max(ordered.length - 1, 0));
  const branches = queryClient.getQueryData<BranchList>(keys.branches(rootLineId, true))?.branches ?? [];
  const place = (hit: SearchHit) =>
    hitPlace(hit, rootLineId, branches, queryClient.getQueryData<MessagePage>(keys.messages(hit.lineId))?.messages, queryClient.getQueryData<FoldList>(keys.folds(hit.lineId))?.folds);
  const jump = (index: number) => {
    const hit = ordered[index];
    if (!hit) return;
    setActive(index);
    onJump(hit.lineId, hit.messageId);
    if (narrow) setResultsOpen(false);
  };
  const step = (by: number) => {
    if (ordered.length === 0) return;
    jump((current + by + ordered.length) % ordered.length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setResultsOpen(true);
      setActive((index) => Math.max(0, Math.min(ordered.length - 1, (Math.min(index, ordered.length - 1) + (event.key === "ArrowDown" ? 1 : -1)))));
    } else if (event.key === "Enter") {
      event.preventDefault();
      jump(current);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  const lineText = (hit: SearchHit) => {
    const at = place(hit);
    const where = at.line.kind === "main" ? t("search.main") : at.line.aside ? t("search.aside", { title: at.line.purpose }) : t("search.branch", { title: at.line.purpose });
    const parts = [hit.kind === "message" ? `${hit.role === "user" ? t("search.you") : t("search.ai")}・${where}${at.n ? ` #${at.n}` : ""}` : where];
    if (at.fold) parts.push(t("search.inFold", { a: at.fold.from, b: at.fold.to }));
    return parts.join("・");
  };
  const searching = serverOn && long && server.isFetching && !server.data;
  const status = !query.trim() ? null : !long ? t("search.minChars") : serverOn && server.isError ? null : searching ? null : ordered.length === 0 ? t("search.none", { q }) : t("search.count", { count: ordered.length });
  const group = (kind: SearchHit["kind"], title: string) => {
    const items = ordered.map((hit, index) => ({ hit, index })).filter((entry) => entry.hit.kind === kind);
    if (items.length === 0) return null;
    return (
      <li role="presentation" className="flex flex-col">
        <span role="presentation" className="px-2.5 pt-2 pb-1 text-tg-xs font-medium text-tg-subtle">
          {title}
        </span>
        <ul role="group" aria-label={title} className="m-0 flex list-none flex-col p-0">
          {items.map(({ hit, index }) => (
            <li
              key={`${hit.lineId}:${hit.messageId ?? hit.kind}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => jump(index)}
              className="flex cursor-pointer flex-col gap-0.5 rounded-tg-sm px-2.5 py-1.5 hover:bg-tg-accent aria-selected:bg-tg-accent aria-selected:shadow-[inset_3px_0_0_var(--tg-ring)] pointer-coarse:min-h-11"
            >
              <Snippet hit={hit} />
              <span className="text-tg-xs text-tg-muted">{lineText(hit)}</span>
            </li>
          ))}
        </ul>
      </li>
    );
  };
  const showList = resultsOpen && long && ordered.length > 0;
  return (
    <div
      role="search"
      aria-label={t("search.inTree")}
      onFocus={() => onFocusWithin?.(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && onFocusWithin?.(false)}
      className={cx("relative z-20 flex shrink-0 flex-col border-b border-tg-border bg-tg-background", className)}
    >
      <div className="flex min-h-8 items-center gap-2 px-3 py-1.5 sm:px-8 pointer-coarse:min-h-11">
        <TextSearch aria-hidden className="size-4 shrink-0 text-tg-muted" />
        <input
          ref={input}
          autoFocus
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${current}` : undefined}
          aria-label={t("search.inTree")}
          placeholder={t("search.inTree")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setResultsOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="h-8 min-w-0 flex-1 border-0 bg-transparent text-tg-sm text-tg-foreground outline-none placeholder:text-tg-subtle pointer-coarse:h-11"
        />
        {status && (
          <span role="status" className="shrink-0 text-tg-xs text-tg-muted">
            {status}
          </span>
        )}
        <IconButton label={t("search.prev")} icon={<ChevronUp />} size="sm" tooltip={false} disabled={ordered.length === 0} onClick={() => step(-1)} />
        <IconButton label={t("search.next")} icon={<ChevronDown />} size="sm" tooltip={false} disabled={ordered.length === 0} onClick={() => step(1)} />
        <span className="hidden shrink-0 text-tg-xs text-tg-subtle md:inline">{t("search.scope")}</span>
        <IconButton label={t("search.close")} icon={<X />} size="sm" tooltip={false} onClick={onClose} />
      </div>
      {!serverOn && query.trim() && <p className="m-0 px-3 pb-1.5 text-tg-xs text-tg-muted sm:px-8">{t("search.scopeLoaded")}</p>}
      {serverOn && long && server.isError && (
        <div role="alert" className="flex items-center gap-2 px-3 pb-1.5 text-tg-xs text-tg-destructive sm:px-8">
          {t("search.failed", { reason: describeError(server.error, t, hostErrorText) })}
          <Button size="sm" onClick={() => void server.refetch()}>
            {t("search.retry")}
          </Button>
        </div>
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("search.inTree")}
          className={cx(
            "absolute top-full z-30 m-0 flex list-none flex-col overflow-auto border border-tg-border-strong bg-tg-surface-raised p-1 shadow-tg-overlay",
            narrow ? "inset-x-0 h-[calc(100dvh-9rem)] rounded-none" : "right-3 w-140 max-w-[calc(100%-1.5rem)] max-h-[60vh] rounded-tg sm:right-8",
          )}
        >
          {group("purpose", t("search.purposes"))}
          {group("message", t("search.messages"))}
        </ul>
      )}
    </div>
  );
}
