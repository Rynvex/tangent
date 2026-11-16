import type { MessageTag } from "@tangent/client";
import { Check, Copy, Ellipsis, GitBranch, PencilLine, Pin, PinOff, SquareParking } from "lucide-react";
import { lazy, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { LazyRegion } from "../components/lazy-region";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";

/** What the 「⋯」 menu and the touch action sheet can hold (labels and icons live with their lazy chunk). */
export type MessageMenuItemId = "branch" | "park" | "editBranch" | "askAgain" | "regenerate" | "diverge" | "note" | "memo" | "term" | "listToSeeds" | "spinoff" | "relate" | "fold" | "move" | "extract" | "pin";

export interface MessageMenuItem {
  id: MessageMenuItemId;
  run?: () => void;
  /** Shown at 45% with its reason (the first message's 修改並分岔). */
  disabled?: boolean;
  /** 將清單存入停車場（n 項）. */
  count?: number;
  /** 釘選's state now. */
  pinned?: boolean;
}

/** The menu's content: groups of items (separated), plus the argument type control (ibis). */
export interface MessageMenuModel {
  /** The row's name ("AI・#2"), for the sheet's title and the tag's labels. */
  who: string;
  groups: MessageMenuItem[][];
  /** Every primary action too, for the touch sheet (which replaces the toolbar). */
  primary: MessageMenuItem[];
  /** 標論證類型… (ibis): the message's type now; the lazy menu writes the change. */
  tag?: { current: MessageTag | null; rootLineId: string; messageId: string; onFailed?: (reason: string) => void };
  /** What 複製 puts on the clipboard (the sheet has its own copy row). */
  text: string;
}

export interface MessageActionsProps {
  /** What "copy" puts on the clipboard. */
  text: string;
  /** Whose message: a reply keeps 開支線, 停車, 複製 in view; the user's own 修改並分岔, 複製, 釘選 (F8 decision #1). */
  role?: "assistant" | "user";
  /** The row's name ("AI・#2"), for the touch sheet's title. */
  who?: string;
  onBranch?: () => void;
  /** Notes feature (F3 wires it). */
  onNote?: () => void;
  /** Parking feature (P1). */
  onPark?: () => void;
  /** 記成備忘 (the memo feature, F10): the message's text as a memo of the line. */
  onMemo?: () => void;
  /** 存進名詞表 (the glossary feature, F19): the message as a term's explanation. */
  onTerm?: () => void;
  /** "Move from here into a branch" (A7), on the user's own messages. */
  onMove?: () => void;
  /** 從這則抽成支線… (F13 S3), on both roles' finished messages. */
  onExtract?: () => void;
  /** 「從這裡開新對話」 (the spinoff feature, B2). */
  onSpinoff?: () => void;
  /** 釘選 / 取消釘選 (B9, core); `pinned` is the message's state now. */
  onPin?: () => void;
  pinned?: boolean;
  /** 關聯… (the relations feature, C3): relate this message to another place without dragging. */
  onRelate?: () => void;
  /** 從這則起折疊… (the fold feature, D4). */
  onFold?: () => void;
  /** 給我幾個方向… (the diverge feature, D3), on a finished reply. */
  onDiverge?: () => void;
  /** 修改並分岔… (F8 S6) on the user's message; `editBlocked` on the line's first one, with 改問，開成新對話… instead. */
  onEditBranch?: () => void;
  editBlocked?: boolean;
  onAskAgain?: () => void;
  /** 分岔重答（可換模型）… (F8 S7) on a finished reply. */
  onRegenerate?: () => void;
  /** 將清單存入停車場（n 項）… (F8 S11): the lazy menu offers it when the reply's list has two or more items. */
  onListToSeeds?: () => void;
  /** 標論證類型… (ibis): the message's type and how to change it. */
  tag?: MessageMenuModel["tag"];
  className?: string;
}

const COPIED_MS = 1500;

/** The menu and the touch sheet load the first time one is opened. */
const MessageMenu = lazy(() => import("./message-menu"));
const MessageSheet = lazy(() => import("./message-menu").then((module) => ({ default: module.MessageSheet })));

const ACTION =
  "inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-tg-sm px-2 font-tg-sans text-tg-xs transition-colors duration-(--tg-duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring aria-disabled:opacity-45";
const MUTED = "text-tg-muted hover:bg-tg-accent hover:text-tg-foreground";

interface ActionProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "muted" | "primary";
  iconOnly?: boolean;
  /** A toggle (釘選): its state for assistive tech. */
  pressed?: boolean;
  disabled?: boolean;
}

function Action({ icon, label, onClick, tone = "muted", iconOnly = false, pressed, disabled }: ActionProps) {
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => !disabled && onClick()}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-label={iconOnly ? label : undefined}
      title={label}
      className={cx(ACTION, tone === "primary" ? "text-tg-primary-text hover:bg-tg-primary-soft" : MUTED)}
    >
      {icon}
      {/* Narrow containers (≤ 480px) keep only the icons; the name stays for screen readers. */}
      {!iconOnly && <span className="@max-[30rem]/tg-messages:sr-only">{label}</span>}
    </button>
  );
}

function useCopy(text: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => setCopied(false),
    );
  };
  return [copied, copy];
}

const item = (id: MessageMenuItemId, run: (() => void) | undefined, extra: Omit<MessageMenuItem, "id" | "run"> = {}): MessageMenuItem[] => (run ? [{ id, run, ...extra }] : []);

/**
 * Which actions stay in view and which go into 「⋯」 (S1): a reply keeps
 * 開支線, 停車 (釘選 when parking is off) and 複製; the user's message
 * 修改並分岔, 複製 and 釘選. The menu is ordered by use: re-ask and diverge |
 * keep and connect | pin. Actions whose feature is off are absent.
 */
export function messageActionModel(props: MessageActionsProps): MessageMenuModel {
  const pin = item("pin", props.onPin, { pinned: props.pinned ?? false });
  const base = { who: props.who ?? "", text: props.text, ...(props.tag ? { tag: props.tag } : {}) };
  if (props.role === "user") {
    const edit: MessageMenuItem[] = props.editBlocked ? [{ id: "editBranch", disabled: true }] : item("editBranch", props.onEditBranch);
    const groups = [props.editBlocked ? [...edit, ...item("askAgain", props.onAskAgain)] : [], [...item("extract", props.onExtract), ...item("memo", props.onMemo), ...item("term", props.onTerm), ...item("move", props.onMove), ...item("spinoff", props.onSpinoff), ...item("relate", props.onRelate), ...item("fold", props.onFold)]];
    return { ...base, primary: [...edit, ...pin], groups: groups.filter((group) => group.length > 0) };
  }
  const park = item("park", props.onPark);
  const groups = [
    [...item("regenerate", props.onRegenerate), ...item("diverge", props.onDiverge)],
    [...item("note", props.onNote), ...item("memo", props.onMemo), ...item("term", props.onTerm), ...item("listToSeeds", props.onListToSeeds), ...item("extract", props.onExtract), ...item("spinoff", props.onSpinoff), ...item("relate", props.onRelate), ...item("fold", props.onFold)],
    park.length > 0 ? pin : [],
  ];
  return { ...base, primary: [...item("branch", props.onBranch), ...(park.length > 0 ? park : pin)], groups: groups.filter((group) => group.length > 0) };
}

/** Arrow keys move between the toolbar's buttons; Tab stops once (S1 states table). */
function onToolbarKey(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > button")];
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : step !== 0 && at >= 0 ? (at + step + buttons.length) % buttons.length : -1;
  if (next < 0) return;
  event.preventDefault();
  buttons[next]?.focus();
}

/** The 「⋯」 button and, once pressed, its menu (lazy); focus comes back to it when the menu closes. */
function MoreButton({ model, open, setOpen }: { model: MessageMenuModel; open: boolean; setOpen: (open: boolean) => void }) {
  const t = useUiT();
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <MoreTrigger anchor={anchor} open={open} label={t("message.moreActions")} onClick={() => setOpen(!open)} />
      {open && (
        <LazyRegion>
          <MessageMenu model={model} anchor={anchor} onClose={() => setOpen(false)} />
        </LazyRegion>
      )}
    </>
  );
}

function MoreTrigger({ anchor, open, label, onClick }: { anchor: RefObject<HTMLButtonElement | null>; open: boolean; label: string; onClick: () => void }) {
  return (
    <button ref={anchor} type="button" tabIndex={-1} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={onClick} className={cx(ACTION, MUTED)}>
      <Ellipsis aria-hidden className="size-3.5" />
    </button>
  );
}

/** The toolbar's buttons: built only once the message was pointed at or focused (a long transcript has thousands of rows). */
function ToolbarButtons({ open, setOpen, ...props }: MessageActionsProps & { open: boolean; setOpen: (open: boolean) => void }) {
  const t = useUiT();
  const [copied, copy] = useCopy(props.text);
  const model = messageActionModel(props);
  const labels: Partial<Record<MessageMenuItemId, string>> = { branch: t("message.branch"), park: t("composer.park"), editBranch: t("message.editBranchShort"), pin: props.pinned ? t("message.unpin") : t("message.pin") };
  const icons: Partial<Record<MessageMenuItemId, ReactNode>> = {
    branch: <GitBranch aria-hidden className="size-3.5" />,
    park: <SquareParking aria-hidden className="size-3.5" />,
    editBranch: <PencilLine aria-hidden className="size-3.5" />,
    pin: props.pinned ? <PinOff aria-hidden className="size-3.5" /> : <Pin aria-hidden className="size-3.5" />,
  };
  const action = (entry: MessageMenuItem) => (
    <Action
      key={entry.id}
      icon={icons[entry.id]}
      label={labels[entry.id] ?? entry.id}
      tone={entry.id === "branch" ? "primary" : "muted"}
      iconOnly={entry.id === "pin"}
      {...(entry.id === "pin" ? { pressed: entry.pinned ?? false } : {})}
      disabled={entry.disabled ?? false}
      onClick={() => entry.run?.()}
    />
  );
  const copyAction = <Action key="copy" icon={copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />} label={copied ? t("message.copied") : t("message.copy")} iconOnly onClick={copy} />;
  // The user's side: 修改並分岔, 複製, 釘選; a reply's: 開支線, 停車 (or 釘選), 複製.
  const [first, ...rest] = model.primary;
  const buttons = props.role === "user" && first?.id === "editBranch" ? [action(first), copyAction, ...rest.map(action)] : props.role === "user" ? [copyAction, ...model.primary.map(action)] : [...model.primary.map(action), copyAction];
  const hasMenu = model.groups.length > 0 || model.tag !== undefined;
  return (
    <>
      {buttons}
      {hasMenu && <MoreButton model={model} open={open} setOpen={setOpen} />}
    </>
  );
}

const firstButton = (bar: HTMLElement | null) => bar?.querySelector<HTMLButtonElement>(":scope > button") ?? null;

/**
 * The actions of a message (S1, components.md `MessageActions`): a toolbar
 * floating at a reply's top right (the user's bubble: left of it, clear of
 * the label row), shown on hover or focus inside the message (it takes no
 * height), three actions and 「⋯」 for the rest. Its buttons are rendered
 * from the first time the message is pointed at or focused. Touch screens
 * get the label row's 「⋯」 instead (`MessageSheetButton`). A viewer keeps
 * only copy.
 */
export function MessageActions(props: MessageActionsProps) {
  const t = useUiT();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (armed) return undefined;
    const host = bar.current?.parentElement;
    if (!host) return undefined;
    const arm = () => setArmed(true);
    host.addEventListener("pointerenter", arm);
    host.addEventListener("focusin", arm);
    return () => {
      host.removeEventListener("pointerenter", arm);
      host.removeEventListener("focusin", arm);
    };
  }, [armed]);
  // Tab reached the empty box first: focus moves on to the first button once it exists.
  useEffect(() => {
    if (armed && document.activeElement === bar.current) firstButton(bar.current)?.focus();
  }, [armed]);
  return (
    <div
      ref={bar}
      role="toolbar"
      aria-label={t("message.actions")}
      data-tg-actions=""
      data-open={open || undefined}
      onKeyDown={onToolbarKey}
      // One Tab stop: the toolbar hands focus to its first button, then arrows move.
      tabIndex={0}
      onFocus={(event) => event.target === event.currentTarget && firstButton(event.currentTarget)?.focus()}
      className={cx(
        // A reply's label row is on the left, so the toolbar takes the top right (into the row's top padding: rows clip, content-visibility).
        // The user's label row is on the right (its type badge too), so the toolbar sits left of the bubble, level with it, so the
        // pointer reaches it straight from the bubble; a narrow column has no room there and uses the top right too.
        props.role === "user" ? "top-4 right-full @max-[30rem]/tg-messages:-top-3 @max-[30rem]/tg-messages:right-0" : "-top-3 right-0",
        "pointer-events-none absolute z-10 flex items-center gap-0.5 rounded-tg border border-tg-border bg-tg-surface p-0.5 opacity-0 shadow-tg transition-opacity duration-(--tg-duration-fast) group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 data-open:pointer-events-auto data-open:opacity-100 motion-reduce:transition-none pointer-coarse:hidden",
        props.className,
      )}
    >
      {armed && <ToolbarButtons {...props} open={open} setOpen={setOpen} />}
    </div>
  );
}

let coarse: boolean | undefined;

/**
 * True on a touch-first screen (the label row's 「⋯」 replaces the hover
 * toolbar there). Read once per page: a device rarely changes its primary
 * pointer, and every row asks.
 */
export function useCoarsePointer(): boolean {
  coarse ??= typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return coarse;
}

/** Touch screens (S1 375): one 「⋯」 in the label row opens the bottom action sheet with every action; nothing elsewhere. */
export function MessageSheetButton(props: MessageActionsProps) {
  const t = useUiT();
  const [open, setOpen] = useState(false);
  if (!useCoarsePointer()) return null;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t("message.moreActions")}
        onClick={() => setOpen(true)}
        className="hidden size-11 items-center justify-center rounded-tg-sm text-tg-muted hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:inline-flex"
      >
        <Ellipsis aria-hidden className="size-4" />
      </button>
      {open && (
        <LazyRegion>
          <MessageSheet model={messageActionModel(props)} onClose={() => setOpen(false)} />
        </LazyRegion>
      )}
    </>
  );
}
