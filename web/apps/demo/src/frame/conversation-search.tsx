import type { SearchHit } from "@tangent/client";
import { Button, describeError, useSearch, useTangent, useUiT, type MessageKey } from "@tangent/react";
import { Archive } from "lucide-react";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDebounced } from "./hooks";
import { browserStorage } from "./prefs";
import { groupHits, highlightParts, leadToHit, loadIncludeArchived, mergeHits, nextIndex, saveIncludeArchived, searchPhase, type ListedHit } from "./search-model";

/** The server is asked once typing pauses this long. */
const SEARCH_DEBOUNCE_MS = 250;

const GROUP_KEYS: Record<SearchHit["kind"], MessageKey> = { title: "search.groupTitle", purpose: "search.groupPurpose", message: "search.groupMessage" };

/** The snippet with its matched ranges in <mark>: React text nodes only, never HTML. */
function Snippet({ hit }: { hit: ListedHit }) {
  return (
    <span className="line-clamp-3 text-tg-sm break-words text-tg-foreground">
      {leadToHit(highlightParts(hit.snippet, hit.highlights)).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-[0.125rem] bg-tg-highlight px-px text-tg-foreground-strong">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function where(hit: SearchHit, t: ReturnType<typeof useUiT>): string {
  if (hit.kind === "title") return "";
  const inTitle = t("search.inConversation", { title: hit.rootTitle || t("shell.untitled") });
  if (hit.kind === "purpose") return inTitle;
  const who = hit.role === "user" ? t("search.you") : t("search.ai");
  return [inTitle, hit.purpose, who].filter(Boolean).join("・");
}

export interface ServerSearch {
  /** Props for the search input (combobox). */
  inputProps: {
    role: "combobox";
    "aria-expanded": boolean;
    /** Only while the listbox is there (it is rendered only with results). */
    "aria-controls"?: string;
    "aria-autocomplete": "list";
    "aria-activedescendant"?: string;
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  };
  results: ReactNode;
}

/**
 * The conversation list's server search (DESIGN §12 F3, B5 `GET /search`):
 * the input stays focused as a combobox; ↑ ↓ move through the results, Enter
 * opens the active one at its message, Esc clears. Results are grouped
 * (titles, branch purposes, messages) with the hit ranges marked; 包含封存
 * (kept per browser) adds the archived conversations' hits, labelled.
 */
export function useServerSearch(enabled: boolean, query: string, onClear: () => void, onOpen: (lineId: string, messageId?: string) => void): ServerSearch {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const listboxId = useId();
  const optionId = useId();
  const settled = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const phase = searchPhase(query);
  const asking = enabled && phase === "search" && searchPhase(settled) === "search";
  // 包含封存: the server searches active or archived conversations per request, so this asks twice and merges.
  const [includeArchived, setIncludeArchived] = useState(() => loadIncludeArchived(browserStorage()));
  const search = useSearch(settled, asking);
  const archivedSearch = useSearch(settled, asking && includeArchived, true);
  const [active, setActive] = useState<{ query: string; index: number }>({ query: "", index: -1 });
  const activeHits = search.data && search.data.query === settled ? search.data.hits : null;
  const archivedHits = includeArchived ? (archivedSearch.data && archivedSearch.data.query === settled ? archivedSearch.data.hits : null) : [];
  const current = activeHits && archivedHits ? mergeHits(activeHits, archivedHits) : null;
  // Either request can fail; the message shows the first reason and 再試一次 asks again for every failed one.
  const failures = [search, ...(includeArchived ? [archivedSearch] : [])].filter((query) => query.isError);
  const failed = failures[0] ?? null;
  const groups = current ? groupHits(current) : [];
  const toggleArchived = () => {
    saveIncludeArchived(browserStorage(), !includeArchived);
    setIncludeArchived(!includeArchived);
  };
  const flat = groups.flatMap((group) => group.hits);
  const index = active.query === settled ? active.index : -1;
  const open = (hit: ListedHit) => onOpen(hit.lineId, hit.messageId);
  const id = (position: number) => `${optionId}-${position}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive({ query: settled, index: nextIndex(index, event.key === "ArrowDown" ? 1 : -1, flat.length) });
    } else if (event.key === "Enter") {
      const hit = flat[index] ?? flat[0];
      if (!hit) return;
      event.preventDefault();
      open(hit);
    } else if (event.key === "Escape" && query !== "") {
      // Esc clears the search; it must not also go up a level or close the drawer.
      event.preventDefault();
      event.stopPropagation();
      onClear();
    }
  };

  let body: ReactNode = null;
  if (phase === "tooShort") body = <p className="m-0 px-2.5 py-1 text-tg-sm text-tg-muted">{t("search.tooShort")}</p>;
  else if (phase === "search" && failed)
    body = (
      <div role="alert" className="flex flex-col items-start gap-2 px-2.5 py-1 text-tg-sm text-tg-muted">
        {t("search.failed", { reason: describeError(failed.error, t, hostErrorText) })}
        <Button size="sm" onClick={() => failures.forEach((query) => void query.refetch())}>
          {t("search.retry")}
        </Button>
      </div>
    );
  // One live region for 搜尋中… and 沒有結果, kept mounted while searching so both are announced.
  const status = phase !== "search" || failed ? "" : !current ? t("search.loading") : flat.length === 0 ? t("search.empty", { query: settled }) : "";

  let position = -1;
  const listbox =
    flat.length > 0 ? (
      <div id={listboxId} role="listbox" aria-label={t("shell.searchResults")} className="flex flex-col gap-2">
        {groups.map((group) => (
          <div key={group.kind} role="group" aria-label={t(GROUP_KEYS[group.kind])} className="flex flex-col gap-0.5">
            <span aria-hidden className="px-2 pt-1 text-tg-xs font-medium text-tg-subtle">
              {t(GROUP_KEYS[group.kind])}
            </span>
            {group.hits.map((hit) => {
              position += 1;
              const mine = position;
              const meta = where(hit, t);
              return (
                <div
                  key={`${hit.kind}:${hit.lineId}:${hit.messageId ?? ""}`}
                  id={id(mine)}
                  role="option"
                  aria-selected={mine === index}
                  data-line-id={hit.lineId}
                  {...(hit.messageId ? { "data-message-id": hit.messageId } : {})}
                  // Keep focus in the search box.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => open(hit)}
                  className="flex cursor-pointer flex-col gap-0.5 rounded-tg-sm px-2.5 py-1.5 hover:bg-tg-accent aria-selected:bg-tg-accent aria-selected:outline-2 aria-selected:outline-tg-ring pointer-coarse:min-h-11"
                >
                  <Snippet hit={hit} />
                  {(meta || hit.archived) && (
                    <span className="flex min-w-0 items-center gap-1.5 text-tg-xs text-tg-muted">
                      {hit.archived && <span className="shrink-0 rounded-tg-sm border border-tg-border-strong px-1">{t("search.archived")}</span>}
                      <span className="truncate">{meta}</span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    ) : null;

  return {
    inputProps: {
      role: "combobox",
      "aria-expanded": flat.length > 0,
      ...(listbox ? { "aria-controls": listboxId } : {}),
      "aria-autocomplete": "list",
      ...(index >= 0 && flat[index] ? { "aria-activedescendant": id(index) } : {}),
      onKeyDown,
    },
    results:
      phase === "idle" ? null : (
        <div className="flex flex-col gap-1">
          <div className="flex justify-end px-1">
            <button
              type="button"
              aria-pressed={includeArchived}
              // Keep focus (and the arrow keys) in the search box.
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleArchived}
              className="inline-flex h-6 items-center gap-1 rounded-tg-sm px-2 text-tg-xs text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring aria-pressed:bg-tg-primary-soft aria-pressed:text-tg-primary-text pointer-coarse:h-11"
            >
              <Archive aria-hidden className="size-3" />
              {t("search.includeArchived")}
            </button>
          </div>
          {body}
          {phase === "search" && (
            <p role="status" className={status ? "m-0 px-2.5 py-1 text-tg-sm text-tg-muted" : "sr-only"}>
              {status}
            </p>
          )}
          {listbox}
          <p className="m-0 px-2.5 py-2 text-tg-xs text-tg-subtle">{t("search.hint")}</p>
        </div>
      ),
  };
}
