import { folderLineCount, groupByFolder, isFeatureOn, knownFolderNames, knownTagCounts, tagLineCount, type LineView } from "@tangent/client";
import { Button, IconButton, LazyRegion, ShortcutKeys, Skeleton, useCapabilities, useLineOrganization, useLines, useReadOnly, useTangent, useUiT, type MessageKey } from "@tangent/react";
import { Archive, ChevronDown, ChevronRight, ClipboardList, FileUp, GitBranch, Library, PanelLeft, Plus, Search } from "lucide-react";
import { lazy, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { ConversationMenu } from "./conversation-menu";
import { useServerSearch } from "./conversation-search";
import { cx } from "./cx";
import { useShellT } from "./f8-shell-messages";
import { collapsedFolders, useStringSet } from "./f13-prefs";
import { useF13ShellT } from "./f13-shell-messages";
import { FolderGroup, TagFilterBanner, TagFilterChips, TagPills } from "./list-organize";
import { groupLines, isWaiting, matchesSearch, splitPinned, timeLabel, type LineGroupKey } from "./list-model";
import { pinnedRoots, usePinnedRoots, type PinnedStore } from "./pinned-roots";
import { hour12For, usePrefs } from "./prefs";
import { RenameField } from "./rename-conversation";

/** A1 conversation list (demo): search, groups by time, archive, empty and loading states. */

/**
 * A virtual anchor that finds the row each time it is measured: changing the
 * folder moves (remounts) the row, and the popover follows it there.
 */
function rowAnchor(lineId: string) {
  const find = () => document.querySelector(`[data-tg-list-row="${CSS.escape(lineId)}"]`);
  return { getBoundingClientRect: () => find()?.getBoundingClientRect() ?? new DOMRect(), get contextElement() { return find() ?? undefined; } };
}

/** F13 S5: the folder-and-tags popover, held here (beside the row it is about) and loaded on first use. */
const FolderTagsPopover = lazy(() => import("./folder-tags-popover"));

const GROUP_KEYS: Record<LineGroupKey, MessageKey> = {
  today: "shell.groupToday",
  yesterday: "shell.groupYesterday",
  week: "shell.groupWeek",
  earlier: "shell.groupEarlier",
};

function Activity({ line, tagHighlight }: { line: LineView; tagHighlight?: string | null }) {
  const t = useUiT();
  // G2 (Settings → General): the open / unread / waiting counts can be hidden; tags stay.
  const showBadges = usePrefs().activityBadges;
  const parts = [
    line.branchCounts.open > 0 ? t("shell.activityOpen", { count: line.branchCounts.open }) : null,
    line.branchUnread > 0 ? t("shell.activityUnread", { count: line.branchUnread }) : null,
    line.awaitingReview > 0 ? t("shell.activityWaiting", { count: line.awaitingReview }) : null,
  ].filter((part): part is string => showBadges && part !== null);
  if (parts.length === 0 && line.tags.length === 0) return null;
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-tg-xs text-tg-muted">
      {parts.length > 0 && (
        <>
          <GitBranch aria-hidden className="size-3 shrink-0 text-tg-branch-open" />
          <span className="min-w-0 truncate">{parts.join("・")}</span>
          {isWaiting(line) && <span aria-hidden className="size-1.5 shrink-0 rounded-tg-full bg-tg-primary" />}
        </>
      )}
      {/* F13 S1: up to two #tag pills after the status (the filtered one in primary). */}
      <TagPills tags={line.tags} highlight={tagHighlight ?? null} />
    </span>
  );
}

interface RowProps {
  line: LineView;
  current: boolean;
  now: Date;
  onSelect: (lineId: string) => void;
  onDelete: (line: LineView) => void;
  /** The row is being renamed (S5): its title becomes a text field. */
  renaming: boolean;
  onRename: (lineId: string | null) => void;
  pinned: PinnedStore;
  /** F13: the filtered tag (its pill shows in primary). */
  tagHighlight?: string | null;
  /** F13 S5: the menu's 資料夾與標籤… and 拆解與整理建議…. */
  organize?: { onDecompose?: (line: LineView) => void; onFolderTags?: (line: LineView) => void };
  /** A row inside a folder: indented, square on its left. */
  inFolder?: boolean;
}

function Row({ line, current, now, onSelect, onDelete, renaming, onRename, pinned, tagHighlight, organize, inFolder = false }: RowProps) {
  const t = useUiT();
  const { locale } = useTangent();
  const readOnly = useReadOnly();
  const hour12 = hour12For(usePrefs(), locale);
  const title = line.title || t("shell.untitled");
  const archived = Boolean(line.archivedAt);
  if (renaming) {
    return (
      <div className="flex rounded-tg-sm bg-tg-accent px-1.5 py-1.5">
        <RenameField
          line={line}
          onDone={() => {
            onRename(null);
            // The field goes; focus returns to the row it replaced.
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tg-row-id="${CSS.escape(line.id)}"]`)?.focus());
          }}
        />
      </div>
    );
  }
  return (
    <div className="group relative flex" data-tg-list-row={line.id}>
      <button
        type="button"
        data-tg-row-id={line.id}
        aria-current={current ? "page" : undefined}
        onClick={() => onSelect(line.id)}
        className={cx(
          "group/row flex w-full min-w-0 flex-col justify-center gap-0.5 py-2 pr-9 pl-2.5 text-left text-tg-foreground hover:bg-tg-accent aria-[current=page]:bg-tg-accent pointer-coarse:min-h-13 pointer-coarse:pr-12",
          inFolder ? "rounded-r-tg-sm" : "rounded-tg-sm",
        )}
      >
        <span className="flex w-full items-baseline gap-2">
          <span className={archived ? "min-w-0 flex-1 truncate text-tg-sm text-tg-muted" : "min-w-0 flex-1 truncate font-medium"}>{title}</span>
          {/* subtle fails 4.5:1 on the accent fill (styles.css), so hovered and current rows use muted. */}
          <span className="shrink-0 text-tg-xs text-tg-subtle group-hover/row:text-tg-muted group-aria-[current=page]/row:text-tg-muted">{timeLabel(line.lastActivityAt, now, locale, undefined, hour12)}</span>
        </span>
        {!archived && <Activity line={line} tagHighlight={tagHighlight} />}
      </button>
      {/* F7: 封存 and 刪除對話… in one menu; it stays visible while its popup is open (focus is in the popup then).
          Centred, and a touch row is at least one hit target tall, so the 44px trigger never reaches into the next row. */}
      {!readOnly && (
        <ConversationMenu
          line={line}
          onDelete={onDelete}
          onRename={(target) => onRename(target.id)}
          pinned={pinned}
          {...organize}
          size="sm"
          className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 pointer-coarse:right-0 pointer-coarse:opacity-100"
        />
      )}
    </div>
  );
}

function GroupHeading({ children }: { children: string }) {
  return <h2 className="m-0 px-2 pt-3 pb-1 text-tg-xs font-medium text-tg-subtle">{children}</h2>;
}

function Empty({ onNew }: { onNew: () => void }) {
  const t = useUiT();
  const readOnly = useReadOnly();
  return (
    <div className="flex flex-col items-start gap-2 px-2.5 py-4">
      <p className="m-0 font-medium text-tg-foreground-strong">{t("shell.emptyTitle")}</p>
      <p className="m-0 text-tg-sm text-tg-muted">{t("shell.emptyBody")}</p>
      {!readOnly && (
        <Button variant="primary" size="sm" icon={<Plus aria-hidden className="size-3.5" />} onClick={onNew}>
          {t("shell.newConversation")}
        </Button>
      )}
    </div>
  );
}

export interface ConversationListProps {
  current: string | null;
  /** A conversation was chosen; a search hit also names the line and message to show. */
  onSelect: (lineId: string, messageId?: string) => void;
  onNew: () => void;
  /** 刪除對話… on a row (F7): the frame confirms and deletes. */
  onDelete: (line: LineView) => void;
  onCollapse?: (() => void) | undefined;
  /** Fixed clock for tests and screenshots; defaults to now. */
  now?: Date;
  /** 回顧 at the bottom (S5); left out, no button. */
  onReview?: () => void;
  /** 待處理 on the conversation on screen, shown on 回顧. */
  reviewCount?: number;
  /** 記憶庫 at the bottom, while the memory feature is on. */
  onOpenLibrary?: () => void;
  /** Tests pass their own store; the page's otherwise. */
  pinned?: PinnedStore;
  /** F13 S2: 匯入對話 (left of 新對話; never for a viewer). */
  onImport?: () => void;
  /** F13 S4: a row menu's 拆解與整理建議…. */
  onDecompose?: (line: LineView) => void;
  /** F13: what a folder action has to say (removed, failed). */
  toast?: (message: string) => void;
  width?: number;
  resizer?: ReactNode;
}

/** 回顧 and 記憶庫, fixed under the list (S5): they stay while the list scrolls. */
function ListFooter({ onReview, reviewCount = 0, onOpenLibrary }: Pick<ConversationListProps, "onReview" | "reviewCount" | "onOpenLibrary">) {
  const s = useShellT();
  if (!onReview && !onOpenLibrary) return null;
  const button =
    "flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-tg-sm px-2.5 text-left text-tg-sm text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-tg-muted";
  return (
    <div className="flex shrink-0 gap-1.5 border-t border-tg-border p-2">
      {onReview && (
        <button type="button" onClick={onReview} aria-label={reviewCount > 0 ? s("list.reviewCount", { count: reviewCount }) : undefined} className={button}>
          <ClipboardList aria-hidden />
          <span className="min-w-0 flex-1 truncate">{s("list.review")}</span>
          {reviewCount > 0 && (
            <span aria-hidden className="rounded-tg-full bg-tg-primary px-1.5 text-tg-xs leading-5 font-semibold text-tg-primary-foreground">
              {reviewCount}
            </span>
          )}
        </button>
      )}
      {onOpenLibrary && (
        <button type="button" onClick={onOpenLibrary} className={button}>
          <Library aria-hidden />
          <span className="min-w-0 flex-1 truncate">{s("list.memory")}</span>
        </button>
      )}
    </div>
  );
}

export function ConversationList({
  current,
  onSelect,
  onNew,
  onDelete,
  onCollapse,
  now = new Date(),
  onReview,
  reviewCount,
  onOpenLibrary,
  pinned = pinnedRoots,
  onImport,
  onDecompose,
  toast,
  width,
  resizer,
}: ConversationListProps) {
  const t = useUiT();
  const s = useShellT();
  const f13 = useF13ShellT();
  const readOnly = useReadOnly();
  const lines = useLines();
  const archived = useLines({ archived: true });
  const [query, setQuery] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // F13 S1: one #tag at a time; the server lists that tag's conversations (the first page of them). The chips' and the
  // banner's counts are the tenant's (B18.1).
  const [tag, setTag] = useState<string | null>(null);
  const tagged = useLines({ tag: tag ?? "" }, tag !== null);
  const collapsed = useStringSet(collapsedFolders);
  const pinnedIds = usePinnedRoots(pinned);
  const all = lines.data?.lines ?? [];
  const archivedLines = archived.data?.lines ?? [];
  const searching = query.trim() !== "";
  // With the search feature on, the server searches titles, branch purposes and messages (B5); otherwise titles here.
  const capabilities = useCapabilities();
  const serverSearch = isFeatureOn(capabilities.data, "search");
  const memoryOn = isFeatureOn(capabilities.data, "memory");
  // B18.1: names and counts over every main line of the tenant (GET /lines/organization), not this page or filter;
  // the loaded conversations stand in until it is read.
  const organization = useLineOrganization().data;
  const counts = knownTagCounts(organization, all);
  const filtered = tag ? (tagged.data?.lines ?? []) : null;
  const { pinned: pinnedLines, rest } = splitPinned(filtered ?? all, filtered ? [] : pinnedIds);
  // Folders with only archived conversations (or only conversations on later pages) still show while nothing is filtered.
  const { folders, unfiled } = groupByFolder(rest, filtered ? [] : knownFolderNames(organization, archivedLines));
  const [organizing, setOrganizing] = useState<string | null>(null);
  const organize = { ...(onDecompose ? { onDecompose } : {}), onFolderTags: (line: LineView) => setOrganizing(line.id) };
  const row = (line: LineView, inFolder = false) => (
    <Row
      key={line.id}
      line={line}
      current={line.id === current}
      now={now}
      onSelect={onSelect}
      onDelete={onDelete}
      renaming={line.id === renamingId}
      onRename={setRenamingId}
      pinned={pinned}
      tagHighlight={tag}
      organize={organize}
      inFolder={inFolder}
    />
  );
  const server = useServerSearch(serverSearch, query, () => setQuery(""), onSelect);
  const matches = searching && !serverSearch ? [...all, ...archivedLines].filter((line) => matchesSearch(line, query)) : [];

  const logoBgId = useId();

  return (
    <nav
      aria-label={t("shell.conversations")}
      style={width !== undefined ? { width } : undefined}
      className={cx("relative flex h-full shrink-0 flex-col border-r border-tg-border bg-tg-surface-sunken", width === undefined && "w-66")}
    >
      <div className="flex h-13 items-center gap-2 pr-3 pl-4">
        <svg aria-hidden="true" viewBox="0 0 32 32" fill="none" className="size-5.5 shrink-0">
          <defs>
            <linearGradient id={logoBgId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#0D9488" />
              <stop offset="100%" stopColor="#115E59" />
            </linearGradient>
          </defs>
          <rect width="32" height="32" rx="8" fill={`url(#${logoBgId})`} />
          <path d="M12 21.5C12 16.5 15.5 15.5 19.5 15.5" stroke="#5EEAD4" strokeWidth="3" strokeLinecap="round" />
          <path d="M7.5 9H24.5" stroke="#FAF8F5" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M12 9V24.5" stroke="#FAF8F5" strokeWidth="3.5" strokeLinecap="round" />
          <rect x="19" y="12.2" width="6.8" height="6.8" rx="2" fill="#5EEAD4" />
        </svg>
        <span className="text-tg-md font-semibold tracking-[0.01em] text-tg-foreground-strong">{t("shell.appName")}</span>
        <span className="flex-1" />
        {!readOnly && onImport && <IconButton label={f13("list.import")} icon={<FileUp />} onClick={onImport} />}
        {!readOnly && <IconButton label={t("shell.newConversation")} icon={<Plus />} onClick={onNew} />}
        {onCollapse && <IconButton label={t("shell.collapseList")} icon={<PanelLeft />} onClick={onCollapse} />}
      </div>
      <div className="px-3 pb-2">
        <label className="flex h-8.5 items-center gap-2 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2.5 text-tg-subtle focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-tg-ring">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            type={serverSearch ? "text" : "search"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            {...(serverSearch
              ? server.inputProps
              : {
                  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key !== "Escape" || query === "") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery("");
                  },
                })}
            aria-label={t("shell.search")}
            placeholder={t("shell.search")}
            className="min-w-0 flex-1 border-0 bg-transparent text-tg-sm text-tg-foreground outline-none placeholder:text-tg-subtle"
          />
          <ShortcutKeys command="palette.open" hint />
        </label>
      </div>
      {!searching && <TagFilterChips counts={counts} selected={tag} onSelect={setTag} loading={lines.isPending} />}
      {!searching && tag && <TagFilterBanner tag={tag} count={tagLineCount(organization, tag, tagged.isSuccess ? tagged.data.lines.length : null)} onClear={() => setTag(null)} />}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2 pt-1 pb-3">
        {lines.isPending && (
          <div role="status" aria-label={t("ui.loading")} className="flex flex-col">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="mx-2 my-2 h-9" />
            ))}
          </div>
        )}
        {lines.isError && (
          <div role="alert" className="flex flex-col items-start gap-2 px-2.5 py-3 text-tg-sm text-tg-muted">
            {t("shell.loadFailed")}
            <Button size="sm" onClick={() => void lines.refetch()}>
              {t("shell.retry")}
            </Button>
          </div>
        )}
        {searching && serverSearch && server.results}
        {searching && !serverSearch && (
          <section aria-label={t("shell.searchResults")} className="flex flex-col gap-0.5">
            <GroupHeading>{t("shell.searchResults")}</GroupHeading>
            {matches.map((line) => row(line))}
            {matches.length === 0 && <p className="m-0 px-2.5 py-1 text-tg-sm text-tg-muted">{t("shell.noResults", { query: query.trim() })}</p>}
            <p className="m-0 px-2.5 py-2 text-tg-xs text-tg-subtle">{t("shell.searchHint")}</p>
          </section>
        )}
        {!searching && lines.isSuccess && all.length === 0 && <Empty onNew={onNew} />}
        {!searching && filtered && tagged.isSuccess && filtered.length === 0 && <p className="m-0 px-2.5 py-2 text-tg-sm text-tg-muted">{f13("list.filterEmpty", { tag: `#${tag}` })}</p>}
        {!searching && pinnedLines.length > 0 && (
          <section aria-label={s("list.pinned")} className="flex flex-col gap-0.5">
            <GroupHeading>{s("list.pinned")}</GroupHeading>
            {pinnedLines.map((line) => row(line))}
          </section>
        )}
        {!searching &&
          folders
            .filter((group) => !filtered || group.lines.length > 0)
            .map((group) => (
              <FolderGroup
                key={group.folder}
                folder={group.folder}
                count={filtered ? group.lines.length : folderLineCount(organization, group.folder, group.lines.length)}
                // While filtering, every folder with a match is open.
                open={Boolean(filtered) || !collapsed.includes(group.folder)}
                onToggle={() => collapsedFolders.set(group.folder, !collapsed.includes(group.folder))}
                readOnly={readOnly}
                onDissolved={(folder, updated) => toast?.(f13("folder.dissolved", { folder, n: updated }))}
                onFailed={(message) => toast?.(message)}
              >
                {group.lines.map((line) => row(line, true))}
              </FolderGroup>
            ))}
        {!searching && filtered && unfiled.length > 0 && (
          <section aria-label={f13("list.uncategorized")} className="flex flex-col gap-0.5">
            <GroupHeading>{f13("list.uncategorized")}</GroupHeading>
            {unfiled.map((line) => row(line))}
          </section>
        )}
        {!searching &&
          !filtered &&
          groupLines(unfiled, now).map((group) => (
            <section key={group.key} aria-label={t(GROUP_KEYS[group.key])} className="flex flex-col gap-0.5">
              <GroupHeading>{t(GROUP_KEYS[group.key])}</GroupHeading>
              {group.lines.map((line) => row(line))}
            </section>
          ))}
        {!searching && !filtered && archivedLines.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={archiveOpen}
              onClick={() => setArchiveOpen(!archiveOpen)}
              className="mt-3 flex items-center gap-2 rounded-tg-sm px-2.5 py-2 text-left text-tg-sm text-tg-muted hover:bg-tg-accent"
            >
              {archiveOpen ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
              <Archive aria-hidden className="size-3.5" />
              {t("shell.archived", { count: archivedLines.length })}
            </button>
            {archiveOpen && archivedLines.map((line) => row(line))}
          </>
        )}
      </div>
      {organizing && (
        <LazyRegion>
          <FolderTagsPopover
            lineId={organizing}
            open
            onOpenChange={(open) => !open && setOrganizing(null)}
            // The row it is about, wherever its folder puts it now (a new folder remounts the row elsewhere).
            anchor={rowAnchor(organizing)}
          />
        </LazyRegion>
      )}
      <ListFooter {...(onReview ? { onReview } : {})} {...(reviewCount !== undefined ? { reviewCount } : {})} {...(onOpenLibrary && memoryOn ? { onOpenLibrary } : {})} />
      {resizer}
    </nav>
  );
}

export interface ConversationRailProps {
  current: string | null;
  onSelect: (lineId: string) => void;
  onExpand: () => void;
  onNew: () => void;
}

/** The 56px icon rail of 1024–1279 px. */
export function ConversationRail({ current, onSelect, onExpand, onNew }: ConversationRailProps) {
  const t = useUiT();
  const readOnly = useReadOnly();
  const lines = useLines();
  return (
    <nav aria-label={t("shell.conversations")} className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-tg-border bg-tg-surface-sunken py-2.5">
      <IconButton label={t("shell.expandList")} icon={<PanelLeft />} onClick={onExpand} />
      {!readOnly && <IconButton label={t("shell.newConversation")} icon={<Plus />} onClick={onNew} />}
      <IconButton label={t("shell.search")} icon={<Search />} onClick={onExpand} />
      <span aria-hidden className="my-1.5 h-px w-6 bg-tg-border-strong" />
      {lines.data?.lines.map((line) => {
        const title = line.title || t("shell.untitled");
        return (
          <button
            key={line.id}
            type="button"
            aria-label={title}
            title={title}
            aria-current={line.id === current ? "page" : undefined}
            onClick={() => onSelect(line.id)}
            className="relative grid size-9 place-items-center rounded-tg-sm border border-transparent text-tg-sm font-medium text-tg-foreground hover:bg-tg-accent aria-[current=page]:border-tg-border-strong aria-[current=page]:bg-tg-accent"
          >
            {Array.from(title)[0]}
            {isWaiting(line) && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-tg-full bg-tg-primary" />}
          </button>
        );
      })}
    </nav>
  );
}
