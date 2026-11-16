import { isFeatureOn, type LineView } from "@tangent/client";
import { IconButton, LazyRegion, Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, ShortcutKeys, useArchiveLine, useCapabilities, useUiT } from "@tangent/react";
import { Archive, ArchiveRestore, ArrowUpToLine, Bookmark, BookmarkCheck, Download, Ellipsis, Folder, PenLine, Sparkles, TextSearch, Trash2 } from "lucide-react";
import type { AsideDefault } from "./aside-default";
import { asideDefaults, useAsideDefault, type AsideDefaultStore } from "./aside-default-store";
import { useAsideT } from "./aside-messages";
import { lazy, useRef, useState, type ReactNode } from "react";
import { useShellT } from "./f8-shell-messages";
import { ConfirmAction, type ConfirmKind } from "./confirm-action";
import { pinnedRoots, usePinnedRoots, type PinnedStore } from "./pinned-roots";
import { usePrefs } from "./prefs";
import { RenameConversationDialog } from "./rename-conversation";
import { menuSeen, useStringSet } from "./f13-prefs";
import { useF13ShellT } from "./f13-shell-messages";

/** F13 S5: the folder-and-tags popover loads the first time it opens. */
const FolderTagsPopover = lazy(() => import("./folder-tags-popover"));

export interface ConversationMenuProps {
  /** A main line: archiving and deleting are for whole conversations only. */
  line: LineView;
  /** 刪除對話…: the frame asks first (the confirmation dialog). */
  onDelete: (line: LineView) => void;
  /**
   * 重新命名… where the conversation has a row to edit in place (the list).
   * Left out (the header), the menu opens its own small rename dialog.
   */
  onRename?: (line: LineView) => void;
  /** 在對話內搜尋 (the header passes it; on phones this menu is its only entry). */
  onSearchInTree?: () => void;
  /** 匯出… (the header passes it). */
  onExport?: () => void;
  size?: "md" | "sm";
  /** Classes of the trigger (its place in a list row). */
  className?: string;
  /** Tests pass their own store; the page's otherwise. */
  pinned?: PinnedStore;
  /** F18 §2.2: where 順口問預設 is kept (tests pass their own store). */
  asideDefault?: AsideDefaultStore;
  /** F13 S4: 拆解與整理建議… (the frame opens the panel on this conversation). */
  onDecompose?: (line: LineView) => void;
  /**
   * F13 S5: 資料夾與標籤…, when the caller shows the popover itself (the list
   * does: a row moves between folders as they change, so its menu cannot hold it).
   */
  onFolderTags?: (line: LineView) => void;
}

/** 「新」 on an F13 item until it is used once (this browser). */
function NewMark({ id }: { id: string }) {
  const f13 = useF13ShellT();
  const seen = useStringSet(menuSeen);
  if (seen.includes(id)) return null;
  return <span className="ml-auto rounded-tg-full bg-tg-primary-soft px-1.5 text-[11px] leading-4 font-medium text-tg-primary-text">{f13("conv.new")}</span>;
}

/** A menu row with a second, smaller line (置頂對話 / 只在這台裝置; a disabled rename's reason). */
function TwoLines({ main, note }: { main: ReactNode; note: ReactNode }) {
  return (
    <span className="flex flex-col py-1 leading-tight">
      <span>{main}</span>
      <span className="text-tg-xs text-tg-muted">{note}</span>
    </span>
  );
}

/**
 * A conversation's actions (F7, F8 S5), on each row of the list and in the
 * header while the main line is on screen: 重新命名…, 置頂對話 / 取消置頂
 * (this browser only), the header's 在對話內搜尋 and 匯出…, 封存 / 解除封存
 * and 刪除對話…. The caller leaves it out for read-only identities and for
 * branches. G2: unpinning and archiving ask first when Settings → General
 * says so, and 順口問預設 is left out while Settings keeps every quick
 * question (the conversation has no choice of its own then).
 */
export function ConversationMenu({ line, onDelete, onRename, onSearchInTree, onExport, size = "md", className, pinned: store = pinnedRoots, onDecompose, onFolderTags, asideDefault: asideStore = asideDefaults }: ConversationMenuProps) {
  const t = useUiT();
  const a = useAsideT();
  // F18 §2.2: whether this conversation's quick questions are kept from the start (this browser only); only while asides are on.
  const asideOn = isFeatureOn(useCapabilities().data, "aside");
  const asideDefault = useAsideDefault(line.id, asideStore);
  const s = useShellT();
  const f13 = useF13ShellT();
  const trigger = useRef<HTMLButtonElement>(null);
  const [organizing, setOrganizing] = useState(false);
  const archive = useArchiveLine();
  const pinnedIds = usePinnedRoots(store);
  const [renaming, setRenaming] = useState(false);
  const title = line.title || t("shell.untitled");
  const archived = Boolean(line.archivedAt);
  const isPinned = pinnedIds.includes(line.id);
  const prefs = usePrefs();
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const run = (kind: ConfirmKind) => (kind === "unpin" ? store.set(line.id, false) : archive.mutate({ lineId: line.id, archived: true }));
  const togglePin = () => (isPinned && prefs.confirmUnpin ? setConfirming("unpin") : store.set(line.id, !isPinned));
  const toggleArchive = () => (!archived && prefs.confirmArchive ? setConfirming("archive") : archive.mutate({ lineId: line.id, archived: !archived }));
  return (
    <>
      <Menu>
        <MenuTrigger render={<IconButton ref={trigger} label={t("shell.actions", { title })} icon={<Ellipsis />} size={size} tooltip={false} className={className} />} />
        <MenuContent align="end" className="w-53 max-w-[calc(100vw-1rem)]">
          <MenuItem icon={<PenLine aria-hidden />} disabled={archived} onSelect={() => (onRename ? onRename(line) : setRenaming(true))}>
            {archived ? <TwoLines main={s("conv.rename")} note={s("conv.renameArchived")} /> : s("conv.rename")}
          </MenuItem>
          <MenuItem icon={<ArrowUpToLine aria-hidden />} onSelect={togglePin}>
            <TwoLines main={isPinned ? s("conv.unpin") : s("conv.pin")} note={s("conv.pinLocal")} />
          </MenuItem>
          {/* F13 S5: organising, after rename and pin; marked 新 until used. */}
          <MenuSeparator />
          <MenuItem
            icon={<Folder aria-hidden />}
            onSelect={() => {
              menuSeen.set("folderTags", true);
              if (onFolderTags) onFolderTags(line);
              else setOrganizing(true);
            }}
          >
            <span className="flex flex-1 items-center gap-2">
              {f13("conv.folderTags")}
              <NewMark id="folderTags" />
            </span>
          </MenuItem>
          {onDecompose && (
            <MenuItem
              icon={<Sparkles aria-hidden />}
              onSelect={() => {
                menuSeen.set("decompose", true);
                onDecompose(line);
              }}
            >
              <span className="flex flex-1 items-center gap-2">
                {f13("conv.decompose")}
                <NewMark id="decompose" />
              </span>
            </MenuItem>
          )}
          {/* F18 §2.2: a choice, not an action — two radio rows under their label (this browser only, like the pin). */}
          {asideOn && !archived && prefs.asideDefault !== "keep" && (
            <>
              <MenuSeparator />
              <MenuRadioGroup<AsideDefault> label={a("default.item")} note={a("default.local")} value={asideDefault} onValueChange={(value) => asideStore.set(line.id, value)}>
                <MenuRadioItem value="discard" icon={<Bookmark aria-hidden />}>
                  {a("default.discard")}
                </MenuRadioItem>
                <MenuRadioItem value="keep" icon={<BookmarkCheck aria-hidden />}>
                  {a("default.keep")}
                </MenuRadioItem>
              </MenuRadioGroup>
            </>
          )}
          {(onSearchInTree || onExport) && <MenuSeparator />}
          {onSearchInTree && (
            <MenuItem icon={<TextSearch aria-hidden />} shortcut={<ShortcutKeys command="search.inTree" hint />} onSelect={onSearchInTree}>
              {s("conv.searchInTree")}
            </MenuItem>
          )}
          {onExport && (
            <MenuItem icon={<Download aria-hidden />} onSelect={onExport}>
              {s("conv.export")}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />} disabled={archive.isPending} onSelect={toggleArchive}>
            {archived ? t("shell.unarchiveItem") : t("shell.archiveItem")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 aria-hidden />} destructive onSelect={() => onDelete(line)}>
            {t("shell.deleteItem")}
          </MenuItem>
        </MenuContent>
      </Menu>
      {!onRename && <RenameConversationDialog open={renaming} onOpenChange={setRenaming} line={line} />}
      {(prefs.confirmUnpin || prefs.confirmArchive) && <ConfirmAction kind={confirming} title={title} onConfirm={run} onClose={() => setConfirming(null)} />}
      {organizing && (
        <LazyRegion>
          <FolderTagsPopover
            lineId={line.id}
            open={organizing}
            onOpenChange={setOrganizing}
            anchor={() => trigger.current}
            side="bottom"
          />
        </LazyRegion>
      )}
    </>
  );
}
