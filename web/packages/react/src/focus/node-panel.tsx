import { asideDaysLeft, branchTitle, canDeleteBranch, canRenameBranch, chatNumbers, featureMode, isFeatureOn, promoteBlock, type BranchView, type Link, type Memo, type Note } from "@tangent/client";
import { StaleReasons, useStaleReasons } from "../f8/stale-badge";
import { useF8T } from "../i18n/f8-messages";
import { CornerDownLeft, List, X } from "lucide-react";
import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { SegmentedControl } from "../components/segmented-control";
import { useMemos } from "../data/memo-hooks";
import { useNotes } from "../data/branch-queries";
import { NodeMemos, type NodeMemosHandle } from "./node-memos";
import { notesOfNode } from "./node-panel-model";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { Skeleton } from "../components/display";
import { KIND_ICONS, KIND_KEYS } from "../conversation/branch-suggestions";
import { STATUS_KEYS } from "../conversation/models";
import { useBranches, useCapabilities, useLine, useMessages } from "../data/queries";
import { useReadOnly } from "../data/live-hooks";
import { useRenameBranch } from "../data/branch-mutations";
import { useUpdateLine } from "../data/mutations";
import { GroupList } from "../groups/group-list";
import { useFocusT } from "../i18n/focus-messages";
import { BranchLeaf } from "../leaf/branch-leaf";
import { cx } from "../lib/cx";
import { TAG_KIND_KEYS } from "../p3/tag-kinds";
import { RelationsSection } from "../p2/relations-section";
import { useUiLocale } from "../provider";
import { NodeNotes, type NodeNotesHandle } from "./node-notes";
import { useLineMemoRequests } from "./memo-requests";
import { forkPlace, lastForkableId, PANEL_PURPOSE_MAX } from "./node-panel-model";
import { NodeTitle, type NodeTitleHandle } from "./node-title";

/** What the panel's action buttons ask the host to open (its existing dialogs). */
/** `deleteBranch` (F18): an ended aside or a discarded branch, with everything under it; the host asks or offers an undo. */
export type NodePanelAction = "bringBack" | "discard" | "promote" | "spinoff" | "branch" | "keepAside" | "deleteBranch";

/** 從這裡繼續談: what the host's open-branch dialog starts from. */
export interface NodeContinueRequest {
  lineId: string;
  anchorMessageId: string;
  purpose: string;
  excerpt: string;
  /** Said in the dialog when the branch cannot fork from the node itself. */
  notice?: string;
}

/** 請 AI 檢驗理解… (F8 S10): where the investigate branch forks, and the check to put in its composer (never sent by itself). */
export interface NodeCheckRequest extends NodeContinueRequest {
  prompt: string;
  /** The note above the composer: 「已填進輸入框，還沒送出。…」. */
  filledNotice: string;
}

export interface NodePanelHandle {
  /** F2. */
  editTitle: () => void;
  /** N. */
  addNote: () => void;
}

export interface NodePanelProps {
  rootLineId: string;
  /** The chosen node's line (the root id for the main line). */
  lineId: string;
  /** Where the chat is (你在這裡, and the notes block it reads). */
  currentLineId: string;
  /** The panel's ✕; leave it out where the host's container has its own (a sheet). */
  onClose?: () => void;
  /** 到這條, 到結論卡, a note's source, a relation's end, a group's member. */
  onGo: (lineId: string, messageId?: string) => void;
  /** The action buttons; absent: none shown. `lastMessageId` is the node's last finished message. */
  onAction?: (action: NodePanelAction, place: { lineId: string; lastMessageId: string | null }) => void;
  onBringIn?: (text: string) => void;
  onContinue?: (request: NodeContinueRequest) => void;
  /** F8 S10: a memo's 請 AI 檢驗理解…; without it the item is not offered. */
  onCheckUnderstanding?: (request: NodeCheckRequest) => void;
  /** F8 S12: a reason's 看紀要 (the note) and 到那裡 (a relation's other end). */
  onGoToNote?: (note: Note) => void;
  onGoToRelation?: (relation: Link) => void;
  onShowAllNotes?: () => void;
  className?: string;
  ref?: Ref<NodePanelHandle>;
}

const SECTION_HEADING = "m-0 text-tg-xs font-semibold text-tg-muted";

function Block({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-tg-border pt-3">
      {title && <h3 className={SECTION_HEADING}>{title}</h3>}
      {children}
    </div>
  );
}

function useUpdatedAt(at: string): string {
  const { locale } = useUiLocale();
  return useMemo(() => {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
  }, [at, locale]);
}

/**
 * The node panel of focus mode (FOCUS_MODE.md §7, phase 1): what a chosen
 * node is and what can be done with it, without leaving the line on
 * screen. Blocks without content (or whose feature is off) are left out.
 * Conclusion cards are a record: shown and linked, never edited. A viewer
 * sees everything as text. The host places it (floating beside the map,
 * or a sheet on narrow frames) and opens the dialogs its actions name.
 */
export function NodePanel(props: NodePanelProps) {
  const { rootLineId, lineId, currentLineId, onClose, onGo, onAction, onBringIn, onContinue, onCheckUnderstanding, onShowAllNotes, className, ref } = props;
  const t = useFocusT();
  const f8 = useF8T();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const branches = useBranches(rootLineId, true);
  const root = useLine(rootLineId);
  const list = useMemo(() => branches.data?.branches ?? [], [branches.data]);
  const isMain = lineId === rootLineId;
  const branch: BranchView | null = isMain ? null : (list.find((item) => item.lineId === lineId) ?? null);
  const own = useMessages(lineId);
  const parent = useMessages(branch?.parentLineId ?? null);
  const rename = useRenameBranch(rootLineId);
  const retitle = useUpdateLine();
  const title = useRef<NodeTitleHandle>(null);
  const notesRef = useRef<NodeNotesHandle>(null);
  const memosRef = useRef<NodeMemosHandle>(null);
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const memoOn = isFeatureOn(capabilities.data, "memo");
  // 紀要｜備忘 when both are on (§8.1); each side counts this node's own.
  const [kind, setKind] = useState<"notes" | "memos">("notes");
  const shown = memoOn && (!notesOn || kind === "memos") ? "memos" : notesOn ? "notes" : null;
  const notesData = useNotes(rootLineId, notesOn);
  const memosData = useMemos(rootLineId, memoOn);
  const noteCount = useMemo(() => notesOfNode(notesData.data?.notes ?? [], lineId).length, [notesData.data, lineId]);
  const memoCount = useMemo(() => (memosData.data?.memos ?? []).filter((memo) => memo.lineId === lineId).length, [memosData.data, lineId]);
  const isArchived = () => Boolean(root.data?.archivedAt);
  useImperativeHandle(ref, () => ({
    editTitle: () => title.current?.edit(),
    // N writes a memo while memos are on, a note otherwise (§10).
    addNote: () => {
      if (readOnly || isArchived()) return;
      if (memoOn) {
        setKind("memos");
        requestAnimationFrame(() => memosRef.current?.add());
      } else notesRef.current?.add();
    },
  }));
  const requests = useLineMemoRequests(rootLineId, lineId);
  const updatedAt = useUpdatedAt(branch?.lastActivityAt ?? root.data?.lastActivityAt ?? "");

  const parentNumbers = useMemo(() => chatNumbers(parent.data?.messages ?? []), [parent.data]);
  const staleReasons = useStaleReasons(rootLineId, branch);
  const ownMessages = own.data?.messages ?? [];
  const lastMessageId = lastForkableId(ownMessages);
  const replying = ownMessages.some((message) => message.status === "pending");

  if (!root.data || (!isMain && !branch)) {
    // The outline is still loading (or the node just went away): nothing to show yet.
    return (
      <section aria-label={t("focus.panelRegion")} className={cx("flex flex-col gap-2 p-3.5", className)}>
        {onClose && (
          <div className="flex justify-end">
            <IconButton label={t("panel.close")} size="sm" icon={<X aria-hidden />} onClick={onClose} />
          </div>
        )}
        {branches.isPending || root.isPending ? <Skeleton className="h-24 w-full" /> : null}
      </section>
    );
  }

  const archived = Boolean(root.data.archivedAt);
  const isAside = branch?.kind === "aside";
  const nodeTitle = branch ? branchTitle(branch, t) : root.data.title || t("panel.main");
  // Open and ended branches (B13) and the main line; not a promoted one or the previous main line; asides are cleared anyway (S4b).
  const editable = !readOnly && !archived && (isMain || (branch !== null && !isAside && canRenameBranch(branch)));
  const renameHint = branch && branch.status !== "open" ? (branch.status === "merged" ? t("panel.renameHintCard") : t("panel.renameHintEnded")) : undefined;
  const leafMode = featureMode(capabilities.data, "leaf");
  const ibisOn = isFeatureOn(capabilities.data, "ibis");
  const isCurrent = lineId === currentLineId;
  const children = list.filter((item) => item.parentLineId === lineId && item.kind !== "aside").length;
  const count = branch ? branch.messageCount : ownMessages.filter((message) => message.kind === "chat").length;
  const place = branch ? forkPlace(branch, list, parentNumbers) : null;
  const card = branch?.status === "merged" && branch.cardMessageId ? (parent.data?.messages.find((message) => message.id === branch.cardMessageId) ?? null) : null;
  const cardText = card?.meta.card?.conclusion || branch?.conclusionLine || "";
  const writable = !readOnly && !archived;

  const continueFrom = (text: string) => {
    const request = requests.continueRequest(text);
    if (request && onContinue) onContinue(request);
  };
  const act = (action: NodePanelAction) => onAction?.(action, { lineId, lastMessageId });
  const checkUnderstanding = (memo: Memo) => {
    const request = requests.checkRequest(memo);
    if (request && onCheckUnderstanding) onCheckUnderstanding(request);
  };
  // F18: deleting is core (no feature gate); only what the server would take is offered.
  const removal: { id: NodePanelAction; label: string }[] = branch && canDeleteBranch(branch) ? [{ id: "deleteBranch", label: t("panel.deleteBranch") }] : [];
  const actions: { id: NodePanelAction; label: string; primary?: boolean; disabled?: boolean }[] = !writable || !onAction
    ? []
    : isAside
      ? [...(notesOn && branch?.status !== "open" ? [{ id: "keepAside" as const, label: t("panel.keepAside") }] : []), ...removal]
      : branch?.status === "open"
        ? [
            { id: "bringBack", label: t("panel.bringBack"), primary: true, disabled: replying },
            { id: "discard", label: t("panel.discard") },
            ...(promoteBlock(branch) === null ? [{ id: "promote" as const, label: t("panel.promote") }] : []),
            ...(isFeatureOn(capabilities.data, "spinoff") ? [{ id: "spinoff" as const, label: t("panel.spinoff") }] : []),
            ...(lastMessageId ? [{ id: "branch" as const, label: t("panel.branch") }] : []),
          ]
        : [...(lastMessageId ? [{ id: "branch" as const, label: t("panel.branch") }] : []), ...removal];

  return (
    <section aria-label={t("focus.panelRegion")} className={cx("flex flex-col gap-3 p-3.5", className)}>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-h-7 items-center gap-1.5 text-tg-xs text-tg-muted">
          <span aria-hidden className="flex [&_svg]:size-3.25">
            {branch ? KIND_ICONS[branch.kind] : <List />}
          </span>
          <span>{branch ? t(KIND_KEYS[branch.kind]) : t("panel.main")}</span>
          {branch && <span>・{t(STATUS_KEYS[branch.status])}</span>}
          {replying && <span className="text-tg-primary-text">・{t("panel.replying")}</span>}
          {isCurrent && <span className="rounded-tg-full bg-tg-primary px-1.5 text-[0.625rem] leading-4 font-semibold text-tg-primary-foreground">{t("focus.here")}</span>}
          <span className="flex-1" />
          {!isCurrent && (
            <Button size="sm" icon={<CornerDownLeft aria-hidden className="size-3" />} onClick={() => onGo(lineId)}>
              {t("panel.goHere")}
            </Button>
          )}
          {onClose && <IconButton label={t("panel.close")} size="sm" icon={<X aria-hidden />} onClick={onClose} />}
        </div>
        <NodeTitle
          // A new node starts with its own title and no edit in progress.
          key={lineId}
          ref={title}
          title={nodeTitle}
          editable={editable}
          label={isMain ? t("panel.titleLabel") : t("panel.purposeLabel")}
          maxLength={PANEL_PURPOSE_MAX}
          {...(renameHint ? { hint: renameHint } : {})}
          onSave={(text) => (isMain ? retitle.mutateAsync({ lineId, input: { title: text } }) : rename.mutateAsync({ lineId, purpose: text }))}
        />
        {readOnly && <p className="m-0 text-tg-xs text-tg-muted">{t("panel.readonly")}</p>}
        {place && (
          <p className="m-0 text-tg-xs text-tg-muted">
            {place.kind === "main"
              ? place.n === null
                ? t("panel.fromLine", { parent: t("panel.main") })
                : t("panel.fromMain", { n: place.n })
              : place.n === null
                ? t("panel.fromLine", { parent: place.title })
                : t("panel.fromParent", { parent: place.title, n: place.n })}
          </p>
        )}
        {ibisOn && branch?.anchorTag && (
          <span className="self-start rounded-tg-sm border border-tg-border px-1.5 text-tg-xs text-tg-foreground">{t("tag.anchor", { kind: t(TAG_KIND_KEYS[branch.anchorTag.kind]) })}</span>
        )}
        {isAside && branch && branch.status !== "open" && (
          <p className="m-0 text-tg-xs text-tg-muted">{branch.keptAt ? t("branchBar.asideKept") : t("branchBar.asideExpires", { days: asideDaysLeft(branch.closedAt, Date.now()) })}</p>
        )}
      </div>

      {branch && !isAside && branch.status !== "open" && leafMode !== "off" && (
        <Block title={t("panel.leaf")}>
          <BranchLeaf lineId={lineId} mode={leafMode} readOnly={readOnly} />
        </Block>
      )}

      {branch && cardText && (
        <Block title={t("panel.conclusion")}>
          <p className="m-0 line-clamp-3 text-tg-sm break-words text-tg-foreground">{cardText}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" className="text-tg-primary-text" onClick={() => onGo(branch.parentLineId, branch.cardMessageId)}>
              {t("panel.toCard")}
            </Button>
            <span className="text-tg-xs text-tg-subtle">{t("panel.cardLocked")}</span>
          </div>
          {staleReasons.length > 0 && (
            <section aria-label={f8("stale.title")} className="flex flex-col gap-2 rounded-tg-sm border border-tg-warning bg-tg-warning-soft px-3 py-2.5">
              <span className="text-tg-xs font-semibold text-tg-foreground">{f8("stale.badge")}</span>
              <StaleReasons
                reasons={staleReasons}
                {...(props.onGoToNote ? { onGoToNote: props.onGoToNote } : {})}
                {...(props.onGoToRelation ? { onGoToRelation: props.onGoToRelation } : {})}
              />
            </section>
          )}
        </Block>
      )}

      {shown && (
        <Block>
          {notesOn && memoOn && (
            <SegmentedControl
              label={t("notes.kinds")}
              options={[
                { value: "notes" as const, label: `${t("notes.tabNotes")} ${noteCount}` },
                { value: "memos" as const, label: `${t("notes.tabMemos")} ${memoCount}` },
              ]}
              value={shown}
              onValueChange={setKind}
            />
          )}
          {shown === "notes" ? (
            <NodeNotes
              key={lineId}
              ref={notesRef}
              rootLineId={rootLineId}
              lineId={lineId}
              currentLineId={currentLineId}
              nodeTitle={nodeTitle}
              readOnly={!writable}
              onGoToSource={onGo}
              {...(onBringIn ? { onBringIn } : {})}
              {...(onContinue ? { onContinue: (note) => continueFrom(note.text) } : {})}
              {...(onShowAllNotes ? { onShowAllNotes } : {})}
            />
          ) : (
            <NodeMemos
              // Undo, an open add box and marks belong to one node.
              key={lineId}
              ref={memosRef}
              rootLineId={rootLineId}
              lineId={lineId}
              nodeTitle={nodeTitle}
              readOnly={!writable}
              notesOn={notesOn}
              {...(onBringIn ? { onBringIn } : {})}
              {...(onContinue ? { onContinue: continueFrom } : {})}
              {...(onCheckUnderstanding && writable ? { onCheckUnderstanding: checkUnderstanding } : {})}
            />
          )}
        </Block>
      )}

      {!isAside && isFeatureOn(capabilities.data, "relations") && (
        <RelationsSection rootLineId={rootLineId} lineId={lineId} start={{ lineId, label: nodeTitle }} onGo={onGo} className="border-t border-tg-border pt-3" />
      )}
      {branch && !isAside && <GroupList rootLineId={rootLineId} lineId={lineId} onGo={onGo} className="border-t border-tg-border pt-3" />}

      {actions.length > 0 && (
        <Block title={t("panel.actions")}>
          <div className="flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <Button key={action.id} size="sm" variant={action.primary ? "primary" : "secondary"} disabled={action.disabled} onClick={() => act(action.id)}>
                {action.label}
              </Button>
            ))}
          </div>
        </Block>
      )}

      <p className="m-0 border-t border-tg-border pt-3 text-tg-xs text-tg-subtle">
        {t("panel.stats", { count, children })}
        {updatedAt && `・${t("panel.updated", { time: updatedAt })}`}
      </p>
    </section>
  );
}
