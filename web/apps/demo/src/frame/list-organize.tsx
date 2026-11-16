/**
 * The conversation list's F13 parts (S1): the single-choice #tag chips and
 * the filter banner, folder groups with their menu (rename, remove) and the
 * tag pills on a row. Folders are one level (decision #1); the filter is
 * single-choice (decision #2); both live on the server (decision #3).
 */
import { FOLDER_MAX_RUNES, normalizeFolder, visibleTags, type TagCount } from "@tangent/client";
import { describeError, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Skeleton, useRenameFolder, useTangent, useUiT } from "@tangent/react";
import { ChevronDown, ChevronRight, Ellipsis, Folder, FolderOpen, FolderX, Pencil, Tag } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { useF13ShellT } from "./f13-shell-messages";

/** Chips shown before the rest go into 更多 (the design's eight). */
export const TAG_CHIPS_SHOWN = 8;

const CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-tg-full border px-2 text-tg-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring pointer-coarse:h-9 pointer-coarse:px-3";

export interface TagFilterChipsProps {
  counts: readonly TagCount[];
  selected: string | null;
  onSelect: (tag: string | null) => void;
  loading?: boolean;
}

/** 全部、#tag (n)…: one choice, arrows move and select, the rest of the tags in 更多. */
export function TagFilterChips({ counts, selected, onSelect, loading = false }: TagFilterChipsProps) {
  const s = useF13ShellT();
  const group = useRef<HTMLDivElement>(null);
  const first = counts.slice(0, TAG_CHIPS_SHOWN);
  const chosenOutside = selected !== null && !first.some((item) => item.tag === selected) ? counts.find((item) => item.tag === selected) : undefined;
  const shown = chosenOutside ? [...first, chosenOutside] : first;
  const rest = counts.filter((item) => !shown.includes(item));
  const values: Array<string | null> = [null, ...shown.map((item) => item.tag)];
  if (loading) {
    return (
      <div role="status" aria-label={s("list.filterLabel")} className="flex gap-1 px-3 pb-2">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-6 w-16 rounded-tg-full" />
        ))}
      </div>
    );
  }
  if (counts.length === 0 && selected === null) return null;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = (values.indexOf(selected) + step + values.length) % values.length;
    const next = values[index] ?? null;
    onSelect(next);
    group.current?.querySelector<HTMLElement>(`[data-tag-chip="${CSS.escape(next ?? "")}"]`)?.focus();
  };
  const chip = (value: string | null, text: ReactNode, count?: number) => {
    const on = value === selected;
    return (
      <button
        key={value ?? ""}
        type="button"
        role="radio"
        aria-checked={on}
        // When the chosen tag has no chip (it left the last conversation), 全部 keeps the group reachable.
        tabIndex={on || (value === null && !values.includes(selected)) ? 0 : -1}
        data-tag-chip={value ?? ""}
        onClick={() => onSelect(value)}
        className={cx(CHIP, on ? "border-tg-primary bg-tg-primary-soft font-medium text-tg-primary-text" : "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent")}
      >
        {text}
        {count !== undefined && <span className={on ? "text-tg-primary-text" : "text-tg-muted"}>({count})</span>}
      </button>
    );
  };
  return (
    <div className="flex items-center gap-1 px-3 pb-2">
      <div ref={group} role="radiogroup" aria-label={s("list.filterLabel")} onKeyDown={move} className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-0.5 [scrollbar-width:none]">
        {chip(null, s("list.filterAll"))}
        {shown.map((item) => chip(item.tag, `#${item.tag}`, item.count))}
      </div>
      {rest.length > 0 && (
        <Menu>
          <MenuTrigger render={<button type="button" className={cx(CHIP, "border-tg-border-input bg-tg-surface text-tg-muted hover:bg-tg-accent")}>{s("list.filterMore", { n: rest.length })}</button>} />
          <MenuContent align="end" className="max-h-72 w-52 overflow-auto">
            {rest.map((item) => (
              <MenuItem key={item.tag} onSelect={() => onSelect(item.tag)}>
                {s("list.filterChip", { tag: `#${item.tag}`, n: item.count })}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

/** 篩選標籤：#postgres（3 篇） 清除. */
export function TagFilterBanner({ tag, count, onClear }: { tag: string; count: number | null; onClear: () => void }) {
  const s = useF13ShellT();
  return (
    <div className="mx-3 mb-2 flex min-h-7 items-center gap-2 rounded-tg-sm bg-tg-primary-soft px-2 py-1 text-tg-xs text-tg-primary-text">
      <Tag aria-hidden className="size-3.5 shrink-0" />
      <span role="status" className="min-w-0 flex-1 truncate">
        {s("list.filterBanner", { tag: `#${tag}`, n: count ?? "…" })}
      </span>
      <button type="button" onClick={onClear} className="shrink-0 rounded-tg-sm px-1 font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-9">
        {s("list.clearFilter")}
      </button>
    </div>
  );
}

/** Up to two #tag pills and +n on a row (the filtered tag in primary). */
export function TagPills({ tags, highlight }: { tags: readonly string[]; highlight?: string | null }) {
  const s = useF13ShellT();
  const { shown, more } = visibleTags(tags);
  if (shown.length === 0) return null;
  return (
    <span aria-label={s("list.tags", { tags: tags.map((tag) => `#${tag}`).join(" ") })} className="flex shrink-0 items-center gap-1">
      {shown.map((tag) => (
        <span
          key={tag}
          aria-hidden
          className={cx(
            "inline-block h-4.5 max-w-20 min-w-0 truncate rounded-tg-full border px-1.5 text-[11px] leading-[16px]",
            tag === highlight ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border bg-tg-surface text-tg-muted",
          )}
        >
          #{tag}
        </span>
      ))}
      {more > 0 && (
        <span aria-hidden className="text-[11px] text-tg-muted">
          +{more}
        </span>
      )}
    </span>
  );
}

function FolderRenameField({ folder, onDone }: { folder: string; onDone: () => void }) {
  const s = useF13ShellT();
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const rename = useRenameFolder();
  const [value, setValue] = useState(folder);
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const { folder: name, problem } = normalizeFolder(value);
    if (name === "") return setError(s("folder.nameEmpty"));
    if (problem) return setError(problem === "reserved" ? s("folder.nameReserved") : s("folder.nameTooLong", { max: FOLDER_MAX_RUNES }));
    if (name === folder) return onDone();
    rename.mutate({ from: folder, to: name }, { onSuccess: onDone, onError: (failure) => setError(s("folder.renameFailed", { reason: describeError(failure, t, hostErrorText) })) });
  };
  return (
    <div className="flex flex-col gap-1 rounded-tg-sm bg-tg-accent px-1.5 py-1.5">
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={value}
        aria-label={s("folder.renameField", { folder })}
        aria-invalid={error ? true : undefined}
        disabled={rename.isPending}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
        onBlur={() => !rename.isPending && !error && save()}
        className="h-8 w-full rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-tg-sm text-tg-foreground outline-none focus-visible:outline-2 focus-visible:outline-tg-ring"
      />
      {error ? (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      ) : (
        <p className="m-0 text-tg-xs text-tg-muted">{s("folder.renameHint")}</p>
      )}
    </div>
  );
}

export interface FolderGroupProps {
  folder: string;
  /** Unarchived conversations in it (0 shows too). */
  count: number;
  open: boolean;
  onToggle: () => void;
  readOnly: boolean;
  /** After 解散資料夾: how many conversations became unfiled (the frame says so). */
  onDissolved?: (folder: string, updated: number) => void;
  onFailed?: (message: string) => void;
  children: ReactNode;
}

/** A folder (one level): collapse arrow, Folder / FolderOpen, name, count; ⋯ on hover (always on touch); rows indented 12px with a guide line. */
export function FolderGroup({ folder, count, open, onToggle, readOnly, onDissolved, onFailed, children }: FolderGroupProps) {
  const s = useF13ShellT();
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const rename = useRenameFolder();
  const [renaming, setRenaming] = useState(false);
  // The promise, not mutate's callbacks: this group is gone once the lists reload, and the message must still show.
  const dissolve = () =>
    rename.mutateAsync({ from: folder, to: "" }).then(
      (result) => onDissolved?.(folder, result.updated),
      (failure: unknown) => onFailed?.(s("folder.dissolveFailed", { reason: describeError(failure, t, hostErrorText) })),
    );
  return (
    <section aria-label={folder} className="flex flex-col">
      {renaming ? (
        <FolderRenameField folder={folder} onDone={() => setRenaming(false)} />
      ) : (
        <div className="group relative flex">
          <button
            type="button"
            aria-expanded={open}
            disabled={rename.isPending}
            onClick={onToggle}
            onKeyDown={(event) => {
              if ((event.key === "ArrowRight" && !open) || (event.key === "ArrowLeft" && open)) {
                event.preventDefault();
                onToggle();
              }
            }}
            className="flex h-7.5 w-full min-w-0 items-center gap-1.5 rounded-tg-sm pr-8 pl-1 text-left text-tg-sm font-medium text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tg-ring disabled:opacity-45 pointer-coarse:h-11 pointer-coarse:pr-12"
          >
            {open ? <ChevronDown aria-hidden className="size-3.5 shrink-0 text-tg-muted" /> : <ChevronRight aria-hidden className="size-3.5 shrink-0 text-tg-muted" />}
            {open ? <FolderOpen aria-hidden className="size-4 shrink-0 text-tg-muted" /> : <Folder aria-hidden className="size-4 shrink-0 text-tg-muted" />}
            <span className="min-w-0 flex-1 truncate">{folder}</span>
            <span className="shrink-0 text-tg-xs font-normal text-tg-muted" aria-label={s("list.folderCount", { n: count })}>
              {rename.isPending ? s("folder.dissolving") : count}
            </span>
          </button>
          {!readOnly && (
            <Menu>
              <MenuTrigger
                render={
                  <IconButton
                    label={s("folder.menu", { folder })}
                    icon={<Ellipsis />}
                    size="sm"
                    tooltip={false}
                    className="absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
                  />
                }
              />
              <MenuContent align="start" className="w-59 max-w-[calc(100vw-1rem)]">
                <MenuItem icon={<Pencil aria-hidden />} onSelect={() => setRenaming(true)}>
                  {s("folder.rename")}
                </MenuItem>
                <MenuItem icon={<FolderX aria-hidden />} onSelect={dissolve}>
                  <span className="flex flex-col py-1 leading-tight">
                    <span>{s("folder.dissolve")}</span>
                    <span className="text-tg-xs text-tg-muted">{s("folder.dissolveHint")}</span>
                  </span>
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      )}
      {open && <div className="ml-3 flex flex-col gap-0.5 border-l border-tg-border-strong">{children}</div>}
    </section>
  );
}
