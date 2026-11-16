/**
 * F14 SessionNodeCard (S2, the left column, 372 wide): the drag handle
 * (GripVertical; drag it, or Alt+Up and Alt+Down while it has focus), the
 * time badge (sets the time), the source, the role pill (the NodeRoleMenu),
 * the title, "問：… → 答：…", and 「小展開・12 則・1 個時間斷點」 that opens
 * the MiniExpand under it.
 *
 * F16.1: a checkbox for the batch bar, 「已合併 n 篇」 with 拆回, and the
 * compact view (from 8 sessions): one 36px row of checkbox, handle, role
 * pill, title, badge, count and a chevron that opens the card in place.
 */
import { buildMiniExpand, sessionGist, sessionTimes, type AssemblyMode, type AttachPoint, type ImportEdits, type ImportRole, type NodeRole, type TimelineSession } from "@tangent/client";
import { ArrowDown, ChevronDown, ChevronUp, CornerDownRight, ListTree, Merge, Split } from "lucide-react";
import { useMemo, type DragEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { useF14T, type F14T } from "./f14-messages";
import { MiniExpand } from "./mini-expand";
import { DragHandle, SelectBox } from "./node-controls";
import { NodeRoleMenu, type AttachOption } from "./node-role-menu";
import { SessionTime } from "./time-badge";

export interface NodeCardHandlers {
  onToggleExpand: () => void;
  onOpenSegment: (index: number | null) => void;
  onSetTime: (manualTime: string | null) => void;
  onMove: (delta: number) => void;
  onRole: (role: NodeRole) => void;
  onAttach: (point: AttachPoint) => void;
  onToggleRole: (externalId: string, role: ImportRole) => void;
  onToggleRemoved: (externalId: string) => void;
  onDragStart: () => void;
  /** A drag that ended anywhere (dropped elsewhere, or cancelled with Esc). */
  onDragEnd: () => void;
  onDropHere: () => void;
  /** F16.1: the checkbox (`range`: with Shift). */
  onSelect: (range: boolean) => void;
  /** 與上一篇合併 (when there is one above). */
  onMergeUp: (() => void) | null;
  /** 拆回原本的 n 篇. */
  onUnmerge: () => void;
  /** Actions targeting this node when multiple other nodes are selected */
  onAttachSelectedHere?: () => void;
  onMergeSelectedHere?: () => void;
  onMoveSelectedAfter?: () => void;
}

export interface SessionNodeCardProps {
  session: TimelineSession;
  index: number;
  count: number;
  role: NodeRole;
  chapter: number | null;
  mode: AssemblyMode;
  relations: boolean;
  attach: AttachPoint | null;
  attachOptions: readonly AttachOption[];
  edits: ImportEdits;
  expanded: boolean;
  openSegment: number | null;
  dragging: boolean;
  touch: boolean;
  locale: string;
  handlers: NodeCardHandlers;
  /** F16.1 */
  compact: boolean;
  selected: boolean;
  selectedCount?: number;
  /** How many sessions it was merged from (1: not merged). */
  mergedCount: number;
}

const ROLE_STYLE: Readonly<Record<NodeRole, string>> = {
  chapter: "border-tg-primary bg-tg-primary-soft text-tg-primary-text",
  merged_branch: "border-tg-branch-merged bg-tg-surface text-tg-foreground",
  open_branch: "border-tg-branch-open bg-tg-surface text-tg-foreground",
  standalone: "border-tg-border-input bg-tg-surface text-tg-foreground",
};

function useCardData(props: SessionNodeCardProps, t: F14T) {
  const conversation = props.session.conversation;
  const mini = useMemo(() => buildMiniExpand(conversation, props.edits.removed), [conversation, props.edits.removed]);
  const gist = useMemo(() => sessionGist(conversation), [conversation]);
  const timeKind = sessionTimes(props.session).kind;
  const stat = [t("import.stat.messages", { n: mini.messageCount }), mini.breaks > 0 ? t("import.stat.breaks", { n: mini.breaks }) : null, mini.regenerations > 0 ? t("import.stat.regen", { n: mini.regenerations }) : null, timeKind === "file" || timeKind === "none" ? t("import.stat.noTime") : null]
    .filter(Boolean)
    .join("・");
  const n = props.chapter ?? props.index + 1;
  const pill = props.role === "chapter" ? t("role.pill.chapter", { n }) : t(`role.pill.${props.role}`);
  // The compact row shows the short name ("§2", "↳ 支線"); the button's label keeps the full one.
  const shortPill = props.role === "chapter" ? `§${n}` : t(`role.short.${props.role}`);
  return { title: conversation.title || t("import.untitled"), mini, gist, stat, pill, shortPill };
}

function RolePill({ props, title, pill, shown, compact }: { props: SessionNodeCardProps; title: string; pill: string; shown: string; compact: boolean }) {
  const t = useF14T();
  const { handlers, touch } = props;
  return (
    <NodeRoleMenu
      title={title}
      role={props.role}
      mode={props.mode}
      relations={props.relations}
      touch={touch}
      attach={props.attach}
      attachOptions={props.attachOptions}
      canMoveUp={props.index > 0}
      canMoveDown={props.index < props.count - 1}
      onRole={handlers.onRole}
      onAttach={handlers.onAttach}
      onMove={handlers.onMove}
      onMergeUp={handlers.onMergeUp}
      mergedCount={props.mergedCount}
      onUnmerge={handlers.onUnmerge}
      selectedCount={props.selected ? undefined : props.selectedCount}
      onAttachSelectedHere={handlers.onAttachSelectedHere}
      onMergeSelectedHere={handlers.onMergeSelectedHere}
      onMoveSelectedAfter={handlers.onMoveSelectedAfter}
      triggerLabel={`${pill}，${t("role.menu", { title })}`}
      triggerClassName={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-tg-full border px-2 text-tg-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11",
        touch ? "h-8" : "h-5.5",
        compact ? "max-w-28" : "self-start",
        ROLE_STYLE[props.role],
      )}
      trigger={() => <span className="truncate">{shown}</span>}
    />
  );
}

function MergedBadge({ n }: { n: number }) {
  const t = useF14T();
  if (n < 2) return null;
  return <span className="shrink-0 rounded-tg-full border border-tg-border-strong bg-tg-surface-sunken px-1.5 text-[0.6875rem] text-tg-foreground">{t("f161.mergedBadge", { n })}</span>;
}

function Unmerge({ props }: { props: SessionNodeCardProps }) {
  const t = useF14T();
  if (props.mergedCount < 2) return null;
  return (
    <button type="button" data-tg-unmerge="" onClick={props.handlers.onUnmerge} className={cx("inline-flex items-center gap-1 self-start rounded-tg-sm px-1.5 text-tg-xs text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "min-h-10" : "min-h-6.5")}>
      <Split aria-hidden className="size-3.5" />
      {t("f161.unmerge", { n: props.mergedCount })}
    </button>
  );
}

function Controls({ props, title }: { props: SessionNodeCardProps; title: string }) {
  const t = useF14T();
  const { handlers, touch } = props;
  return (
    <>
      <SelectBox checked={props.selected} label={t("f161.select", { title })} touch={touch} onToggle={handlers.onSelect} />
      {/* Phones reorder with the role menu's 上移／下移 (decision #9): a handle there would be a dead button. */}
      {!touch && <DragHandle variant="card" label={t("import.handle", { title })} onDragStart={handlers.onDragStart} onDragEnd={handlers.onDragEnd} onMove={handlers.onMove} className={props.compact ? "h-6" : "h-7"} />}
    </>
  );
}

function Details({ props, data, children }: { props: SessionNodeCardProps; data: ReturnType<typeof useCardData>; children?: ReactNode }) {
  const t = useF14T();
  const { session, touch, handlers } = props;
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        <SessionTime session={session} variant="span" touch={touch} locale={props.locale} onApply={handlers.onSetTime} />
        <span className="min-w-0 truncate text-tg-xs text-tg-muted">{session.fileName ? `${t(`import.source.${session.source}`)}${/\.(md|markdown|txt)$/i.test(session.fileName) ? `・${session.fileName}` : ""}` : t("import.pasted")}</span>
      </div>
      {children}
      {(data.gist.question || data.gist.answer) && <p className="m-0 line-clamp-2 text-tg-xs text-tg-muted">{t("import.gist", { q: data.gist.question, a: data.gist.answer })}</p>}
      {props.selectedCount && props.selectedCount > 0 && !props.selected && handlers.onMergeSelectedHere && (
        <div data-tg-card-target-actions="" className="flex flex-wrap items-center gap-1.5 rounded-tg-sm border border-tg-border-subtle bg-tg-surface-sunken p-1.5">
          <span className="text-[0.6875rem] font-semibold text-tg-foreground-strong">{t("f161.targetActionGroup", { n: props.selectedCount })}</span>
          <button
            type="button"
            data-tg-target-attach=""
            onClick={handlers.onAttachSelectedHere}
            className={cx("inline-flex items-center gap-1 rounded-tg-sm border border-tg-border bg-tg-surface px-1.5 text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "min-h-10" : "h-6.5")}
          >
            <CornerDownRight aria-hidden className="size-3 text-tg-branch-merged" />
            {t("f161.cardAttachHere")}
          </button>
          <button
            type="button"
            data-tg-target-merge=""
            onClick={handlers.onMergeSelectedHere}
            className={cx("inline-flex items-center gap-1 rounded-tg-sm border border-tg-border bg-tg-surface px-1.5 text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "min-h-10" : "h-6.5")}
          >
            <Merge aria-hidden className="size-3 text-tg-primary-text" />
            {t("f161.cardMergeInto")}
          </button>
          <button
            type="button"
            data-tg-target-move=""
            onClick={handlers.onMoveSelectedAfter}
            className={cx("inline-flex items-center gap-1 rounded-tg-sm border border-tg-border bg-tg-surface px-1.5 text-tg-xs text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "min-h-10" : "h-6.5")}
          >
            <ArrowDown aria-hidden className="size-3 text-tg-muted" />
            {t("f161.cardMoveAfter")}
          </button>
        </div>
      )}
      <Unmerge props={props} />
    </>
  );
}

function MiniButton({ props, stat }: { props: SessionNodeCardProps; stat: string }) {
  const t = useF14T();
  return (
    <button
      type="button"
      aria-expanded={props.expanded}
      onClick={props.handlers.onToggleExpand}
      className={cx("inline-flex items-center gap-1 self-start rounded-tg-sm px-1.5 text-tg-xs text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11", props.touch ? "min-h-10" : "min-h-6.5", props.expanded && "bg-tg-primary-soft")}
    >
      <ListTree aria-hidden className="size-3.5" />
      {t("import.miniExpand", { stat })}
      {props.expanded ? <ChevronUp aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
    </button>
  );
}

function CompactRow({ props, data }: { props: SessionNodeCardProps; data: ReturnType<typeof useCardData> }) {
  const t = useF14T();
  return (
    <div className={cx("flex items-center gap-1.5 px-2", props.touch ? "min-h-11" : "h-9")}>
      <Controls props={props} title={data.title} />
      <RolePill props={props} title={data.title} pill={data.pill} shown={data.shortPill} compact />
      <h4 className="m-0 min-w-0 flex-1 truncate text-tg-sm font-semibold text-tg-foreground-strong" title={data.title}>
        {data.title}
      </h4>
      <MergedBadge n={props.mergedCount} />
      {props.selectedCount && props.selectedCount > 0 && !props.selected && props.handlers.onMergeSelectedHere && (
        <div data-tg-card-target-actions="" className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-tg-target-attach=""
            title={t("f161.cardAttachHere")}
            aria-label={`${t("f161.cardAttachHere")}（${t("f161.targetActionGroup", { n: props.selectedCount })}）`}
            onClick={props.handlers.onAttachSelectedHere}
            className={cx("inline-flex shrink-0 items-center gap-0.5 rounded-tg-sm border border-tg-border bg-tg-surface px-1 text-[0.6875rem] font-medium text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "min-h-9" : "h-6")}
          >
            <CornerDownRight aria-hidden className="size-3 text-tg-branch-merged" />
            <span className="hidden sm:inline">{t("f161.cardAttachHere")}</span>
          </button>
          <button
            type="button"
            data-tg-target-merge=""
            title={t("f161.cardMergeInto")}
            aria-label={`${t("f161.cardMergeInto")}（${t("f161.targetActionGroup", { n: props.selectedCount })}）`}
            onClick={props.handlers.onMergeSelectedHere}
            className={cx("inline-flex shrink-0 items-center gap-0.5 rounded-tg-sm border border-tg-border bg-tg-surface px-1 text-[0.6875rem] font-medium text-tg-foreground hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "min-h-9" : "h-6")}
          >
            <Merge aria-hidden className="size-3 text-tg-primary-text" />
            <span className="hidden sm:inline">{t("f161.cardMergeInto")}</span>
          </button>
        </div>
      )}
      <span className="shrink-0 font-tg-mono text-tg-xs text-tg-muted">{t("assembly.messages", { n: data.mini.messageCount })}</span>
      <button
        type="button"
        aria-expanded={props.expanded}
        aria-label={t("f161.details", { title: data.title })}
        onClick={props.handlers.onToggleExpand}
        className={cx("grid shrink-0 place-items-center rounded-tg-sm text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", props.touch ? "size-11" : "size-6")}
      >
        {props.expanded ? <ChevronUp aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
      </button>
    </div>
  );
}

export function SessionNodeCard(props: SessionNodeCardProps) {
  const t = useF14T();
  const { session, handlers } = props;
  const data = useCardData(props, t);
  const mini = props.expanded && (
    <MiniExpand
      conversation={session.conversation}
      mini={data.mini}
      edits={props.edits}
      openSegment={props.openSegment}
      touch={props.touch}
      locale={props.locale}
      onOpenSegment={handlers.onOpenSegment}
      onToggleRole={handlers.onToggleRole}
      onToggleRemoved={handlers.onToggleRemoved}
    />
  );
  return (
    <li
      data-tg-session-node={session.key}
      data-tg-selected={props.selected || undefined}
      onDragOver={(event: DragEvent<HTMLLIElement>) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        handlers.onDropHere();
      }}
      className={cx("overflow-hidden rounded-tg border bg-tg-surface", props.expanded ? "border-tg-border-strong" : "border-tg-border", props.selected && "border-tg-primary bg-tg-primary-soft/40", props.dragging && "opacity-60 shadow-tg")}
    >
      {props.compact ? (
        <>
          <CompactRow props={props} data={data} />
          {props.expanded && (
            <div className="flex flex-col gap-1 border-t border-tg-border px-2 py-2">
              <Details props={props} data={data} />
            </div>
          )}
        </>
      ) : (
        <div className="flex gap-1.5 px-2 py-2">
          <div className="flex shrink-0 flex-col items-center gap-1.5 pt-0.5">
            <Controls props={props} title={data.title} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Details props={props} data={data}>
              <div className="flex flex-wrap items-center gap-1.5">
                <RolePill props={props} title={data.title} pill={data.pill} shown={data.pill} compact={false} />
                <MergedBadge n={props.mergedCount} />
              </div>
              <h4 className="m-0 text-tg-sm font-semibold text-tg-foreground-strong">{data.title}</h4>
            </Details>
            <MiniButton props={props} stat={data.stat} />
          </div>
        </div>
      )}
      {mini}
    </li>
  );
}
