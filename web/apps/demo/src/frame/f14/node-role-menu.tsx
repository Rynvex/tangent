/**
 * F14 NodeRoleMenu: a node's four roles (設為主線章節 §, 掛為支線並留結論卡,
 * 掛為進行中支線, 另存成獨立對話; the current one checked, one the mode
 * cannot take dimmed with the reason), 「掛在」 for a branch, and 上移／下移
 * (decision #9: reordering without dragging). A popover on desktop, a bottom
 * sheet on touch screens. Up and down move between the roles; Esc closes
 * and returns to the button that opened it.
 * F16.1: 與上一篇合併 and 拆回原本的 n 篇 next to 上移／下移.
 */
import type { AssemblyMode, AttachPoint, NodeRole } from "@tangent/client";
import { BottomSheet, Popover, PopoverContent, PopoverTrigger } from "@tangent/react";
import { ArrowDown, ArrowUp, Bookmark, Check, ChevronDown, CornerDownRight, ExternalLink, GitBranch, Merge, Split } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";

const ROLES: ReadonlyArray<{ role: NodeRole; icon: ReactNode; label: "role.chapter" | "role.mergedBranch" | "role.openBranch" | "role.standalone"; sub: "role.chapterSub" | "role.mergedBranchSub" | "role.openBranchSub" | "role.standaloneSub" }> = [
  { role: "chapter", icon: <Bookmark aria-hidden className="size-4" />, label: "role.chapter", sub: "role.chapterSub" },
  { role: "merged_branch", icon: <CornerDownRight aria-hidden className="size-4" />, label: "role.mergedBranch", sub: "role.mergedBranchSub" },
  { role: "open_branch", icon: <GitBranch aria-hidden className="size-4" />, label: "role.openBranch", sub: "role.openBranchSub" },
  { role: "standalone", icon: <ExternalLink aria-hidden className="size-4" />, label: "role.standalone", sub: "role.standaloneSub" },
];

/** One place a branch can hang ("§1 #4（14:58）"). */
export interface AttachOption {
  value: string;
  label: string;
  point: AttachPoint;
}

export const attachValue = (point: AttachPoint) => `${point.sessionKey}|${point.externalId}`;

export interface NodeRoleMenuProps {
  title: string;
  role: NodeRole;
  mode: AssemblyMode;
  relations: boolean;
  touch: boolean;
  /** Where it hangs now, and where it could (branches only). */
  attach: AttachPoint | null;
  attachOptions: readonly AttachOption[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onRole: (role: NodeRole) => void;
  onAttach: (point: AttachPoint) => void;
  onMove: (delta: number) => void;
  /** F16.1: 與上一篇合併 (null: the first one, disabled; left out: not offered). */
  onMergeUp?: (() => void) | null;
  /** How many sessions it was merged from; 拆回原本的 n 篇 from 2. */
  mergedCount?: number;
  onUnmerge?: () => void;
  selectedCount?: number;
  onAttachSelectedHere?: () => void;
  onMergeSelectedHere?: () => void;
  onMoveSelectedAfter?: () => void;
  /** The button's look: the left column's pill or the preview's small button. */
  trigger: (open: boolean) => ReactNode;
  triggerClassName: string;
  triggerLabel?: string;
}

const KEY_STEP: Readonly<Record<string, (at: number, count: number) => number>> = {
  ArrowDown: (at, count) => (at + 1) % count,
  ArrowUp: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

function RoleList({ props, close, checkedRef }: { props: NodeRoleMenuProps; close: () => void; checkedRef: RefObject<HTMLButtonElement | null> }) {
  const t = useF14T();
  const list = useRef<HTMLDivElement>(null);
  const usable = (role: NodeRole) => props.mode !== "batch" || role === "standalone";
  // Up, Down, Home and End move between the roles; one stop for Tab (the checked role).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP[event.key];
    if (!step) return;
    event.preventDefault();
    const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
    items[step(items.indexOf(document.activeElement as HTMLButtonElement), items.length)]?.focus();
  };
  const isBranch = props.role === "merged_branch" || props.role === "open_branch";
  return (
    <div className="flex flex-col gap-1 p-1">
      {props.selectedCount && props.selectedCount > 0 && props.onMergeSelectedHere && (
        <div role="group" aria-label={t("f161.targetActionGroup", { n: props.selectedCount })} className="mb-1 flex flex-col gap-1 border-b border-tg-border px-1 pb-1.5">
          <span className="text-[0.6875rem] font-semibold text-tg-primary-text">{t("f161.targetActionGroup", { n: props.selectedCount })}</span>
          <button
            type="button"
            data-tg-target-attach=""
            onClick={() => {
              props.onAttachSelectedHere?.();
              close();
            }}
            className={cx("flex items-center gap-2 rounded-tg-sm px-2 py-1 text-left text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "min-h-10" : "min-h-7")}
          >
            <CornerDownRight className="size-3.5 text-tg-branch-merged" />
            {t("f161.cardAttachHere")}
          </button>
          <button
            type="button"
            data-tg-target-merge=""
            onClick={() => {
              props.onMergeSelectedHere?.();
              close();
            }}
            className={cx("flex items-center gap-2 rounded-tg-sm px-2 py-1 text-left text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "min-h-10" : "min-h-7")}
          >
            <Merge className="size-3.5 text-tg-primary-text" />
            {t("f161.cardMergeInto")}
          </button>
          <button
            type="button"
            data-tg-target-move=""
            onClick={() => {
              props.onMoveSelectedAfter?.();
              close();
            }}
            className={cx("flex items-center gap-2 rounded-tg-sm px-2 py-1 text-left text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "min-h-10" : "min-h-7")}
          >
            <ArrowDown className="size-3.5 text-tg-muted" />
            {t("f161.cardMoveAfter")}
          </button>
        </div>
      )}
      <div ref={list} role="menu" aria-label={t("role.list")} onKeyDown={onKeyDown} className="flex flex-col">
        {ROLES.map(({ role, icon, label, sub }) => {
          const on = props.role === role;
          const disabled = !usable(role);
          const subText = role === "standalone" && !props.relations ? t("role.standaloneSubNoRelations") : t(sub);
          return (
            <button
              key={role}
              ref={on ? checkedRef : undefined}
              type="button"
              role="menuitemradio"
              tabIndex={on ? 0 : -1}
              aria-checked={on}
              aria-disabled={disabled || undefined}
              title={disabled ? t("role.unavailable") : undefined}
              onClick={() => {
                if (disabled) return;
                props.onRole(role);
                close();
              }}
              className={cx("flex items-start gap-2.5 rounded-tg-sm px-2 py-1.5 text-left hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring aria-disabled:opacity-45", props.touch ? "min-h-11" : "min-h-9", on && "bg-tg-accent")}
            >
              <span className="mt-0.5 text-tg-muted">{icon}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-tg-sm text-tg-foreground">{t(label)}</span>
                <span className="text-tg-xs text-tg-muted">{disabled ? t("role.unavailable") : subText}</span>
              </span>
              {on && <Check aria-hidden className="mt-1 size-4 text-tg-primary-text" />}
            </button>
          );
        })}
      </div>
      {isBranch && props.attachOptions.length > 0 && (
        <label className="flex items-center gap-2 border-t border-tg-border px-2 pt-2 text-tg-xs text-tg-muted">
          {t("role.attachTo")}
          <select
            value={props.attach ? attachValue(props.attach) : ""}
            onChange={(event) => {
              const option = props.attachOptions.find((item) => item.value === event.target.value);
              if (option) props.onAttach(option.point);
            }}
            className={cx("min-w-0 flex-1 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 font-tg-mono text-tg-xs text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "h-10" : "h-7")}
          >
            {props.attachOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex gap-1 border-t border-tg-border px-1 pt-1.5">
        {[
          { delta: -1, can: props.canMoveUp, icon: <ArrowUp aria-hidden className="size-3.5" />, label: t("role.moveUp") },
          { delta: 1, can: props.canMoveDown, icon: <ArrowDown aria-hidden className="size-3.5" />, label: t("role.moveDown") },
        ].map((move) => (
          <button
            key={move.delta}
            type="button"
            disabled={!move.can}
            onClick={() => props.onMove(move.delta)}
            className={cx("inline-flex flex-1 items-center justify-center gap-1 rounded-tg-sm text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45", props.touch ? "h-11" : "h-7")}
          >
            {move.icon}
            {move.label}
          </button>
        ))}
      </div>
      <MergeActions props={props} close={close} />
    </div>
  );
}

function MergeActions({ props, close }: { props: NodeRoleMenuProps; close: () => void }) {
  const t = useF14T();
  const merged = (props.mergedCount ?? 1) > 1;
  if (props.onMergeUp === undefined && !merged) return null;
  const size = props.touch ? "h-11" : "h-7";
  const button = "inline-flex flex-1 items-center justify-center gap-1 rounded-tg-sm text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45";
  return (
    <div className="flex gap-1 px-1">
      {props.onMergeUp !== undefined && (
        <button
          type="button"
          data-tg-merge-up=""
          disabled={props.onMergeUp === null}
          onClick={() => {
            props.onMergeUp?.();
            close();
          }}
          className={cx(button, size)}
        >
          <Merge aria-hidden className="size-3.5" />
          {t("f161.mergeUp")}
        </button>
      )}
      {merged && (
        <button
          type="button"
          onClick={() => {
            props.onUnmerge?.();
            close();
          }}
          className={cx(button, size)}
        >
          <Split aria-hidden className="size-3.5" />
          {t("f161.unmerge", { n: props.mergedCount ?? 1 })}
        </button>
      )}
    </div>
  );
}

export function NodeRoleMenu(props: NodeRoleMenuProps) {
  const t = useF14T();
  const [open, setOpen] = useState(false);
  const checked = useRef<HTMLButtonElement>(null);
  const label = props.triggerLabel ?? t("role.menu", { title: props.title });
  if (props.touch) {
    return (
      <>
        <button type="button" data-tg-role-trigger="" aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => setOpen(true)} className={props.triggerClassName}>
          {props.trigger(open)}
          <ChevronDown aria-hidden className="size-3" />
        </button>
        <BottomSheet open={open} onOpenChange={setOpen} label={label}>
          <RoleList props={props} close={() => setOpen(false)} checkedRef={checked} />
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger data-tg-role-trigger="" aria-label={label} className={props.triggerClassName}>
        {props.trigger(open)}
        <ChevronDown aria-hidden className="size-3" />
      </PopoverTrigger>
      <PopoverContent aria-label={t("role.menu", { title: props.title })} initialFocus={checked} side="bottom" align="end" className="w-67.5 px-0 py-0">
        <RoleList props={props} close={() => setOpen(false)} checkedRef={checked} />
      </PopoverContent>
    </Popover>
  );
}
