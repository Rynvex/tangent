import { MEMORY_IMPORTANCE, MEMORY_KINDS, memoryHistory, type MemoryKind } from "@tangent/client";
import {
  Button,
  describeError,
  Dialog,
  DialogContent,
  MEMORY_KIND_KEYS,
  MemoryItem,
  SegmentedControl,
  Skeleton,
  TextArea,
  useCreateMemory,
  useMemories,
  useMemorySearch,
  useMemoryT,
  useReadOnly,
  useTangent,
} from "@tangent/react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useDebounced } from "./hooks";
import { MemoryCard } from "./memory-card";
import { useLibraryT } from "./memory-messages";
import type { Navigate } from "./branch-flows";

type Filter = MemoryKind | "all";
const SEARCH_DELAY_MS = 300;
const SELECT = "h-9 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-tg-sm text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11";

/** 新增記憶: kind, text and importance; the source is left empty (written here, not in a conversation). */
function AddMemory() {
  const t = useLibraryT();
  const m = useMemoryT();
  const { hostErrorText } = useTangent();
  const create = useCreateMemory();
  const headingId = useId();
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [text, setText] = useState("");
  const [importance, setImportance] = useState<number>(MEMORY_IMPORTANCE.default);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || create.isPending) return;
    setError(null);
    create.mutateAsync({ kind, text: text.trim(), importance }).then(
      () => setText(""),
      (failure: unknown) => setError(t("library.failed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  return (
    <form aria-labelledby={headingId} onSubmit={submit} className="flex flex-col gap-2 rounded-tg border border-tg-border bg-tg-surface-raised px-3 py-3">
      <h3 id={headingId} className="m-0 text-tg-sm font-semibold text-tg-foreground">
        {t("library.add")}
      </h3>
      <span className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-tg-xs text-tg-muted">
          {t("library.kind")}
          <select value={kind} onChange={(event) => setKind(event.currentTarget.value as MemoryKind)} className={SELECT}>
            {MEMORY_KINDS.map((value) => (
              <option key={value} value={value}>
                {m(MEMORY_KIND_KEYS[value])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-tg-xs text-tg-muted">
          {t("library.importance")}
          <select value={importance} onChange={(event) => setImportance(Number(event.currentTarget.value))} className={SELECT}>
            {Array.from({ length: MEMORY_IMPORTANCE.max }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </span>
      <TextArea label={t("library.text")} rows={2} value={text} onChange={(event) => setText(event.currentTarget.value)} />
      <Button type="submit" size="sm" variant="primary" className="self-start" loading={create.isPending} aria-disabled={!text.trim() || undefined}>
        {t("library.remember")}
      </Button>
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** 搜尋記憶: the same search a new conversation's first message makes. */
function SearchMemories() {
  const t = useLibraryT();
  const [query, setQuery] = useState("");
  const settled = useDebounced(query, SEARCH_DELAY_MS);
  const search = useMemorySearch(settled);
  const results = search.data?.results ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-tg border border-tg-border bg-tg-surface-raised px-3 py-3">
      <label className="flex flex-col gap-1 text-tg-sm font-semibold text-tg-foreground">
        {t("library.search")}
        <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} className={`${SELECT} font-normal`} />
      </label>
      <span className="text-tg-xs text-tg-muted">{t("library.searchHint")}</span>
      {search.isSuccess && (
        <ul aria-label={t("library.results")} className="m-0 flex list-none flex-col gap-1.5 p-0">
          {results.length === 0 && <li className="text-tg-xs text-tg-muted">{t("library.noResults")}</li>}
          {results.map(({ memory, similarity }) => (
            <li key={memory.id} className="flex items-start gap-2">
              <MemoryItem memory={memory} className="min-w-0 flex-1 text-tg-xs" />
              <span className="shrink-0 font-tg-mono text-[0.6875rem] text-tg-muted">{t("library.similarity", { value: similarity.toFixed(2) })}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where focus goes once a loaded page is on screen: the first new card, else the button (more to come) or the list. */
interface FocusAfterLoad {
  index: number;
  shownAfter: number;
  hasMore: boolean;
}

/** GET /memories `limit` at most: the replaced versions are read in one page of this size. */
const HISTORY_LIMIT = 200;

/**
 * 載入更多 (B10.1): the next page is appended; focus moves to the first new
 * card (the button may go away on the last page). A failure keeps focus on
 * the button and says why under it. `reset` (a filter change) drops a load
 * still in flight from the focus: its cards belong to the old list.
 */
function useLoadMore(memories: ReturnType<typeof useMemories>, shown: number) {
  const listRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const [focus, setFocus] = useState<FocusAfterLoad | null>(null);
  useEffect(() => {
    if (!focus || shown < focus.shownAfter) return;
    const cards = listRef.current?.querySelectorAll<HTMLElement>(":scope > article");
    const target = cards?.[focus.index] ?? (focus.hasMore ? moreRef.current : listRef.current);
    target?.focus();
    setFocus(null);
  }, [focus, shown]);
  const loadMore = () => {
    if (memories.isFetchingNextPage) return;
    const started = generation.current;
    void memories.fetchNextPage().then((result) => {
      if (started !== generation.current || result.isError || !result.data) return;
      setFocus({ index: shown, shownAfter: result.data.memories.length, hasMore: result.hasNextPage });
    });
  };
  const reset = () => {
    generation.current += 1;
    setFocus(null);
  };
  return { listRef, moreRef, loadMore, reset };
}

/**
 * 記憶庫 (D1; components.md `MemoryLibrary`, demo: main column and a side
 * column, gap 16; filters, replaced history): every active memory of the
 * tenant, newest first, with what each replaced; adding and searching on the
 * side. A page at a time (B10.1): the cards are `status=active` pages (the
 * kind filter goes to the server and starts from the first page; 載入更多
 * appends the next); the replaced versions come from one unfiltered
 * `status=superseded` page (the newest 200), so a card shows its history
 * whatever page or kind the older versions have.
 * A modal dialog (R11): focus moves in, Tab stays inside, Esc or the close
 * button closes it and focus goes back to what opened it.
 */
export function MemoryLibrary({ onClose, navigate }: { onClose: () => void; navigate: Navigate }) {
  const t = useLibraryT();
  const m = useMemoryT();
  const readOnly = useReadOnly();
  const { hostErrorText } = useTangent();
  const [filter, setFilter] = useState<Filter>("all");
  const memories = useMemories({ status: "active", ...(filter === "all" ? {} : { kind: filter }) });
  const replaced = useMemories({ status: "superseded", limit: HISTORY_LIMIT });
  const shown = memories.data?.memories ?? [];
  const history = memoryHistory([...shown, ...(replaced.data?.memories ?? [])]);
  const more = useLoadMore(memories, shown.length);
  const options = [{ value: "all" as Filter, label: t("library.all") }, ...MEMORY_KINDS.map((kind) => ({ value: kind as Filter, label: m(MEMORY_KIND_KEYS[kind]) }))];
  const go = (lineId: string) => {
    navigate(lineId);
    onClose();
  };
  const choose = (next: Filter) => {
    more.reset();
    setFilter(next);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={t("library.title")} description={t("library.lead")} width="page">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(17.5rem,1fr)]">
          <div className="flex min-w-0 flex-col gap-2.5">
            <SegmentedControl label={t("library.kind")} options={options} value={filter} onValueChange={choose} className="self-start" />
            {memories.isPending && <Skeleton className="h-32 w-full" />}
            {memories.isError && !memories.data && (
              <div role="alert" className="flex flex-col items-start gap-2 text-tg-sm text-tg-muted">
                {t("library.loadFailed")}
                <Button size="sm" onClick={() => void memories.refetch()}>
                  {t("library.retry")}
                </Button>
              </div>
            )}
            {memories.data && shown.length === 0 && !memories.hasNextPage && <p className="m-0 text-tg-sm text-tg-muted">{t("library.empty")}</p>}
            <div ref={more.listRef} tabIndex={-1} role="group" aria-label={t("library.list")} className="flex flex-col gap-2.5 outline-none">
              {shown.map((memory) => (
                <MemoryCard key={memory.id} memory={memory} history={history.get(memory.id) ?? []} onGoToSource={go} />
              ))}
            </div>
            {memories.hasNextPage && (
              <Button ref={more.moreRef} size="sm" className="self-start" loading={memories.isFetchingNextPage} onClick={more.loadMore}>
                {t("library.more")}
              </Button>
            )}
            {replaced.isError && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-tg-xs text-tg-muted">
                {t("library.historyFailed")}
                <Button size="sm" onClick={() => void replaced.refetch()}>
                  {t("library.retry")}
                </Button>
              </div>
            )}
            {memories.isFetchNextPageError && (
              <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
                {t("library.moreFailed", { reason: describeError(memories.error, t, hostErrorText) })}
              </p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {!readOnly && <AddMemory />}
            <SearchMemories />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
