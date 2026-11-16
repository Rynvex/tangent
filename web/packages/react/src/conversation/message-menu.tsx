import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { LIST_TO_SEEDS_MIN, markdownListItems, TAG_KINDS, type TagKind } from "@tangent/client";
import {
  BookA,
  ChevronRight,
  Copy,
  ExternalLink,
  FoldVertical,
  GitBranch,
  Link2,
  ListPlus,
  MessageSquarePlus,
  NotebookPen,
  PackageOpen,
  PencilLine,
  Pin,
  PinOff,
  RefreshCcw,
  Scissors,
  Split,
  SquareParking,
  StickyNote,
  Tags,
} from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";
import { MenuContent, MenuItem, MenuSeparator } from "../components/menu";
import { useTagMessage } from "../data/p3-hooks";
import { describeError } from "./error-text";
import { useTangent } from "../provider";
import { POPUP_MOTION } from "../components/tooltip";
import { useF8T } from "../i18n/f8-messages";
import { useF13T } from "../i18n/f13-messages";
import { cx } from "../lib/cx";
import { TAG_KIND_KEYS } from "../p3/tag-kinds";
import { useTangentPortalContainer } from "../root/tangent-root";
import type { MessageMenuItem, MessageMenuItemId, MessageMenuModel } from "./message-actions";

type Translate = ReturnType<typeof useF8T>;

const ICONS: Record<MessageMenuItemId, ReactNode> = {
  branch: <GitBranch aria-hidden />,
  park: <SquareParking aria-hidden />,
  editBranch: <PencilLine aria-hidden />,
  askAgain: <MessageSquarePlus aria-hidden />,
  regenerate: <RefreshCcw aria-hidden />,
  diverge: <Split aria-hidden />,
  note: <NotebookPen aria-hidden />,
  memo: <StickyNote aria-hidden />,
  term: <BookA aria-hidden />,
  listToSeeds: <ListPlus aria-hidden />,
  spinoff: <ExternalLink aria-hidden />,
  relate: <Link2 aria-hidden />,
  fold: <FoldVertical aria-hidden />,
  move: <PackageOpen aria-hidden />,
  extract: <Scissors aria-hidden />,
  pin: <Pin aria-hidden />,
};

function labelOf(entry: MessageMenuItem, t: Translate, t13: ReturnType<typeof useF13T>): string {
  switch (entry.id) {
    case "branch":
      return t("message.branch");
    case "park":
      return t("composer.park");
    case "editBranch":
      return t("message.editBranch");
    case "askAgain":
      return t("edit.asNewConv");
    case "regenerate":
      return t("message.regenerate");
    case "diverge":
      return t("message.diverge");
    case "note":
      return t("message.notes");
    case "memo":
      return t("message.memo");
    case "term":
      return t("message.term");
    case "listToSeeds":
      return t("message.listToSeeds", { n: entry.count ?? 0 });
    case "spinoff":
      return t("message.spinoff");
    case "relate":
      return t("message.relate");
    case "fold":
      return t("message.foldFrom");
    case "move":
      return t("message.moveFrom");
    case "extract":
      return t13("extract.menu");
    case "pin":
      return entry.pinned ? t("message.unpin") : t("message.pin");
  }
}

/** Writes the chosen type (null clears it); a refusal goes to the host's `onFailed`, since the menu is gone by then. */
function useSetTag(tag: MessageMenuModel["tag"]): (kind: TagKind | null) => void {
  const t = useF8T();
  const { hostErrorText } = useTangent();
  const write = useTagMessage(tag?.rootLineId ?? "");
  return (kind) => {
    if (!tag) return;
    write.mutateAsync({ messageId: tag.messageId, kind }).catch((error: unknown) => tag.onFailed?.(t("arg.failed", { reason: describeError(error, t, hostErrorText) })));
  };
}

/** 將清單存入停車場 counts the reply's list here (out of the main bundle) and stays only for two or more items. */
function withListCount(model: MessageMenuModel): MessageMenuModel {
  if (!model.groups.some((group) => group.some((entry) => entry.id === "listToSeeds"))) return model;
  const count = markdownListItems(model.text).length;
  const groups = model.groups
    .map((group) => group.flatMap((entry) => (entry.id !== "listToSeeds" ? [entry] : count >= LIST_TO_SEEDS_MIN ? [{ ...entry, count }] : [])))
    .filter((group) => group.length > 0);
  return { ...model, groups };
}

const iconOf = (entry: MessageMenuItem): ReactNode => (entry.id === "pin" && entry.pinned ? <PinOff aria-hidden /> : ICONS[entry.id]);

/** The 「標論證類型…」 submenu: the five kinds (the current one marked) and, when tagged, 移除類型. */
function TagSubmenu({ tag, t, onDone }: { tag: NonNullable<MessageMenuModel["tag"]>; t: Translate; onDone: () => void }) {
  const container = useTangentPortalContainer();
  const write = useSetTag(tag);
  const set = (kind: TagKind | null) => {
    write(kind);
    onDone();
  };
  return (
    <MenuPrimitive.SubmenuRoot>
      <MenuPrimitive.SubmenuTrigger className="flex min-h-(--tg-control-height) cursor-default items-center gap-2 rounded-tg-sm px-2.5 text-tg-foreground outline-none select-none data-highlighted:bg-tg-accent data-popup-open:bg-tg-accent [&_svg]:size-4 [&_svg]:shrink-0">
        <Tags aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t("arg.setKind")}</span>
        <ChevronRight aria-hidden className="text-tg-muted" />
      </MenuPrimitive.SubmenuTrigger>
      <MenuPrimitive.Portal container={container ?? undefined}>
        <MenuPrimitive.Positioner sideOffset={2} collisionPadding={8} className="z-50">
          <MenuPrimitive.Popup className={cx("flex min-w-40 flex-col rounded-tg border border-tg-border-strong bg-tg-surface-raised p-1 text-tg-sm text-tg-foreground shadow-tg-overlay outline-none", POPUP_MOTION)}>
            {TAG_KINDS.map((kind) => (
              <MenuItem key={kind} onSelect={() => set(kind)}>
                {t(TAG_KIND_KEYS[kind])}
                {tag.current?.kind === kind && <span className="sr-only"> ✓</span>}
              </MenuItem>
            ))}
            {tag.current && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => set(null)}>{t("arg.remove")}</MenuItem>
              </>
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.SubmenuRoot>
  );
}

export interface MessageMenuProps {
  model: MessageMenuModel;
  /** The 「⋯」 button: the popup sits against it and focus returns to it. */
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/**
 * The message's 「⋯」 menu (S1, components.md `MessageMoreMenu`): w252, rows
 * h32, groups split by lines; a disabled item says why (the first message
 * has nowhere to branch from). Arrows move, Esc closes and focus returns to
 * 「⋯」.
 */
export default function MessageMenu({ model: given, anchor, onClose }: MessageMenuProps) {
  const t = useF8T();
  const t13 = useF13T();
  const model = withListCount(given);
  return (
    <MenuPrimitive.Root open modal={false} onOpenChange={(open) => !open && onClose()}>
      <MenuContent align="end" anchor={anchor} finalFocus={anchor} className="w-63">
        {model.groups.map((group, index) => (
          <div key={group.map((entry) => entry.id).join()} role="presentation" className="flex flex-col">
            {index > 0 && <MenuSeparator />}
            {group.map((entry) => (
              <MenuItem key={entry.id} icon={iconOf(entry)} disabled={entry.disabled ?? false} onSelect={() => entry.run?.()}>
                {labelOf(entry, t, t13)}
              </MenuItem>
            ))}
            {group.some((entry) => entry.id === "editBranch" && entry.disabled) && <p className="m-0 px-2.5 pb-1.5 text-tg-xs text-tg-muted">{t("edit.firstMsg")}</p>}
          </div>
        ))}
        {model.tag && (
          <>
            {model.groups.length > 0 && <MenuSeparator />}
            <TagSubmenu tag={model.tag} t={t} onDone={onClose} />
          </>
        )}
      </MenuContent>
    </MenuPrimitive.Root>
  );
}

const SHEET_ROW =
  "flex min-h-11 w-full items-center gap-3 rounded-tg-sm px-3 text-left text-tg-md text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tg-ring aria-disabled:opacity-45 [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-tg-muted";

/** The draft type's row, first in the sheet (decision #8): confirm it, or pick another. */
function SheetTagRow({ tag, t, onDone }: { tag: NonNullable<MessageMenuModel["tag"]>; t: Translate; onDone: () => void }) {
  const [picking, setPicking] = useState(false);
  const write = useSetTag(tag);
  const current = tag.current;
  const set = (kind: TagKind | null) => {
    write(kind);
    onDone();
  };
  return (
    <div className="flex flex-col gap-1 border-b border-tg-border pb-2">
      {current?.status === "draft" && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <span className="min-w-0 flex-1 text-tg-sm text-tg-foreground">{t("arg.sheetRow", { kind: t(TAG_KIND_KEYS[current.kind]) })}</span>
          <button type="button" onClick={() => set(current.kind)} className="h-11 rounded-tg-sm bg-tg-primary px-3 text-tg-sm text-tg-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
            {t("arg.confirmKind", { kind: t(TAG_KIND_KEYS[current.kind]) })}
          </button>
        </div>
      )}
      <button type="button" aria-expanded={picking} onClick={() => setPicking(!picking)} className={SHEET_ROW}>
        <Tags aria-hidden />
        {current ? t("arg.changeKind") : t("arg.setKind")}
      </button>
      {picking && (
        <div role="group" aria-label={t("arg.setKind")} className="flex flex-wrap gap-1.5 px-3 pb-1">
          {TAG_KINDS.map((kind) => (
            <button key={kind} type="button" aria-pressed={current?.kind === kind} onClick={() => set(kind)} className="h-11 rounded-tg-sm border border-tg-border-strong px-3 text-tg-sm aria-pressed:border-tg-primary aria-pressed:bg-tg-primary-soft">
              {t(TAG_KIND_KEYS[kind])}
            </button>
          ))}
          {current && (
            <button type="button" onClick={() => set(null)} className="h-11 rounded-tg-sm px-3 text-tg-sm text-tg-muted hover:bg-tg-accent">
              {t("arg.remove")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface MessageSheetProps {
  model: MessageMenuModel;
  onClose: () => void;
}

/**
 * Touch screens' action sheet (S1 375, components.md `MessageActionSheet`):
 * modal from the bottom, rows h44, at most 90% high, focus kept inside; the
 * argument type first when AI's draft waits, then every action, 複製 and 取消.
 */
export function MessageSheet({ model: given, onClose }: MessageSheetProps) {
  const t = useF8T();
  const t13 = useF13T();
  const model = withListCount(given);
  const container = useTangentPortalContainer();
  const run = (entry: MessageMenuItem) => {
    if (entry.disabled) return;
    onClose();
    entry.run?.();
  };
  const copy = () => {
    void navigator.clipboard?.writeText(model.text);
    onClose();
  };
  const rows = [...model.primary, ...model.groups.flat().filter((entry) => !model.primary.some((shown) => shown.id === entry.id))];
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim" />
        <DialogPrimitive.Popup aria-modal="true" className="fixed inset-x-0 bottom-0 z-50 flex max-h-[90%] flex-col gap-1 overflow-auto rounded-t-tg-lg bg-tg-surface-raised px-2 pt-1.5 pb-2 text-tg-foreground shadow-tg-overlay outline-none">
          <DialogPrimitive.Title className="m-0 px-3 py-2 text-tg-sm font-semibold text-tg-muted">{t("message.sheetTitle", { who: model.who })}</DialogPrimitive.Title>
          {model.tag && <SheetTagRow tag={model.tag} t={t} onDone={onClose} />}
          {rows.map((entry) => (
            <div key={entry.id} className="flex flex-col">
              <button type="button" aria-disabled={entry.disabled || undefined} onClick={() => run(entry)} className={SHEET_ROW}>
                {iconOf(entry)}
                {labelOf(entry, t, t13)}
              </button>
              {entry.id === "editBranch" && entry.disabled && <p className="m-0 px-10 pb-1 text-tg-xs text-tg-muted">{t("edit.firstMsg")}</p>}
            </div>
          ))}
          <button type="button" onClick={copy} className={SHEET_ROW}>
            <Copy aria-hidden />
            {t("message.copy")}
          </button>
          <DialogPrimitive.Close className="mt-1 min-h-11 rounded-tg-sm border border-tg-border text-tg-md text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">{t("message.cancel")}</DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
