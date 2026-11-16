/**
 * F14 BlueprintPreview (S3, the right column): what the import will make.
 * - Timeline and tree: the main line as a trunk with its chapters §1…§n;
 *   branches hang off it with an └ connector, say where ("掛在 §1 #4（14:58）
 *   之後・時間穿插") and, when brought back, carry their card
 *   (BlueprintCardEditor). Separate conversations are listed under it.
 * - Batch: one dashed box for the shared folder and tags, the conversations
 *   in order, linked to the next one (Link2 相關) when relations are on.
 * Each node's role button opens the NodeRoleMenu.
 * F16.1 (desktop): every node has a drag handle (onto the role zones, a
 * chapter or the separate list; Alt+arrows reorder), a chapter shows
 * 「↳ 掛在 §N 下當支線」 and 「⊕ 合併進 §N」 while sessions are dragged or
 * checked, and a merged node says how many it holds.
 * F16.2: after an analysis every node shows its threaded rounds, the reason
 * and its fine-tuning (ai-node-panel.tsx).
 */
import { sessionTimes, type AssemblyBlueprint, type AttachPoint, type BlueprintNode, type NodeRole, type TimelineSession } from "@tangent/client";
import { ClockAlert, CornerDownRight, ExternalLink, FolderOpen, Link2, List } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../cx";
import { AiNodePanel } from "./ai-node-panel";
import { useAiTreeView } from "./ai-tree-context";
import { unitsOfNode } from "./ai-tree-plan";
import { CardEditor } from "./card-editor";
import { ChapterDropTargets, StandaloneDrop } from "./drop-zones";
import { useF14T, type F14T } from "./f14-messages";
import { DragHandle } from "./node-controls";
import { NodeRoleMenu, type AttachOption } from "./node-role-menu";
import { useAssemblyDnd } from "./use-assembly-drag";
import { clockOf, dayOf } from "./time-format";

export interface PreviewHandlers {
  onRole: (key: string, role: NodeRole) => void;
  onAttach: (key: string, point: AttachPoint) => void;
  onMove: (key: string, delta: number) => void;
  onConclusion: (key: string, conclusion: string) => void;
  /** F16.1: merge `key` into the node above it; split a merged one back. */
  onMergeUp: (key: string) => void;
  onUnmerge: (key: string) => void;
  mergedCountOf: (key: string) => number;
}

export interface BlueprintPreviewProps {
  blueprint: AssemblyBlueprint;
  sessions: ReadonlyMap<string, TimelineSession>;
  relations: boolean;
  touch: boolean;
  attachOptions: readonly AttachOption[];
  invalid: ReadonlySet<string>;
  handlers: PreviewHandlers;
  /** Batch's box: the folder, the tags and 改資料夾與標籤. */
  folder: string;
  tags: readonly string[];
  organize: ReactNode;
  onOrganize: () => void;
}

/** "08/12 14:20–18:02", "檔案時間 08/18", or "—". */
function nodeWhen(session: TimelineSession, t: F14T): string {
  const times = sessionTimes(session);
  if (times.start === null) return "—";
  if (times.kind === "file") return t("import.fileTime", { date: dayOf(times.start) });
  const end = times.end ?? times.start;
  return end > times.start ? `${dayOf(times.start)} ${clockOf(times.start)}–${clockOf(end)}` : `${dayOf(times.start)} ${clockOf(times.start)}`;
}

/** Batch's shorter "08/12" (or the file date). */
function batchWhen(session: TimelineSession, t: F14T): string {
  const times = sessionTimes(session);
  if (times.start === null) return "—";
  return times.kind === "file" ? t("import.fileTime", { date: dayOf(times.start) }) : dayOf(times.start);
}

function attachText(node: BlueprintNode, session: TimelineSession, t: F14T): string {
  const attach = node.attach;
  if (!attach || attach.chapter === null) return "";
  const pos = attach.at !== null ? t("assembly.pos", { c: attach.chapter, n: attach.number, time: clockOf(attach.at) }) : t("assembly.posNoTime", { c: attach.chapter, n: attach.number });
  const notes = [node.interleaved ? t("assembly.interleaved") : "", sessionTimes(session).kind === "file" ? t("assembly.byFileTime") : ""].filter(Boolean);
  return [t("assembly.anchoredAfter", { pos }), ...notes].join("・");
}

function Flag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-tg-full bg-tg-warning-soft px-1.5 text-[0.6875rem] text-tg-foreground">
      <ClockAlert aria-hidden className="size-3 text-tg-warning" />
      {children}
    </span>
  );
}

/** The preview's drag handle (desktop; none outside the step's drag state). */
function PreviewHandle({ nodeKey, title, props }: { nodeKey: string; title: string; props: BlueprintPreviewProps }) {
  const t = useF14T();
  const dnd = useAssemblyDnd();
  if (props.touch || !dnd) return null;
  return <DragHandle variant="preview" label={t("f161.previewHandle", { title })} onDragStart={() => dnd.start(nodeKey)} onDragEnd={dnd.end} onMove={(delta) => props.handlers.onMove(nodeKey, delta)} className="h-5.5" />;
}

function MergedCount({ n }: { n: number }) {
  const t = useF14T();
  return n > 1 ? <span className="rounded-tg-full border border-tg-border-strong bg-tg-surface-sunken px-1.5 text-[0.6875rem] text-tg-foreground">{t("f161.mergedBadge", { n })}</span> : null;
}

function NodeBox({ node, session, props, index, count }: { node: BlueprintNode; session: TimelineSession; props: BlueprintPreviewProps; index: number; count: number }) {
  const t = useF14T();
  const title = session.conversation.title || t("import.untitled");
  const branch = node.role === "merged_branch" || node.role === "open_branch";
  const kind = sessionTimes(session).kind;
  const invalid = props.invalid.has(node.key);
  const merged = props.handlers.mergedCountOf(node.key);
  const dragging = useAssemblyDnd()?.dragging?.includes(node.key) ?? false;
  // F16.2: a node the analysis threaded says so itself (跨段整合 N 輪), instead of 已合併 n 篇.
  const ai = useAiTreeView();
  const threaded = ai ? unitsOfNode(ai.analysis, ai.merges, node.key).length > 1 : false;
  return (
    <div data-tg-blueprint-node={node.key} className={cx("relative flex flex-col gap-1 rounded-tg border bg-tg-surface px-2.5 py-2", branch ? "border-tg-branch-merged" : "border-tg-primary", invalid && "border-tg-destructive outline-2 outline-tg-destructive", dragging && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <PreviewHandle nodeKey={node.key} title={title} props={props} />
        {node.role === "chapter" ? (
          <span className="rounded-tg-sm bg-tg-primary-soft px-1.5 font-tg-mono text-tg-xs font-semibold text-tg-primary-text">§{node.chapter}</span>
        ) : (
          <span className="inline-flex items-center gap-0.5 rounded-tg-sm bg-tg-surface-sunken px-1.5 text-tg-xs text-tg-foreground">
            <CornerDownRight aria-hidden className="size-3" />
            {node.role === "merged_branch" ? t("assembly.branchTag") : t("assembly.openTag")}
          </span>
        )}
        <span className="font-tg-mono text-tg-xs text-tg-muted">{nodeWhen(session, t)}</span>
        {node.role === "chapter" && node.interleaved && <Flag>{t("assembly.interleaved")}</Flag>}
        {node.role === "chapter" && (kind === "file" || kind === "none") && <Flag>{t("assembly.noTimestamp")}</Flag>}
        {!threaded && <MergedCount n={merged} />}
        <span className="ml-auto">
          <NodeRoleMenu
            title={title}
            role={node.role}
            mode={props.blueprint.mode}
            relations={props.relations}
            touch={props.touch}
            attach={node.attach?.point ?? null}
            attachOptions={props.attachOptions.filter((option) => option.point.sessionKey !== node.key)}
            canMoveUp={index > 0}
            canMoveDown={index < count - 1}
            onRole={(role) => props.handlers.onRole(node.key, role)}
            onAttach={(point) => props.handlers.onAttach(node.key, point)}
            onMove={(delta) => props.handlers.onMove(node.key, delta)}
            onMergeUp={index > 0 ? () => props.handlers.onMergeUp(node.key) : null}
            mergedCount={merged}
            onUnmerge={() => props.handlers.onUnmerge(node.key)}
            triggerLabel={`${t(`role.short.${node.role}`)}，${t("role.menu", { title })}`}
            triggerClassName={cx("inline-flex items-center gap-1 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11", props.touch ? "h-8" : "h-5.5")}
            trigger={() => <span>{t(`role.short.${node.role}`)}</span>}
          />
        </span>
      </div>
      <p className="m-0 flex items-baseline gap-1.5">
        <span className="text-tg-sm font-semibold text-tg-foreground-strong">{title}</span>
        <span className="font-tg-mono text-tg-xs text-tg-muted">{t("assembly.messages", { n: node.messages })}</span>
      </p>
      {branch && node.attach && node.attach.valid && <p className="m-0 text-tg-xs text-tg-muted">{attachText(node, session, t)}</p>}
      <AiNodePanel node={node} title={title} blueprint={props.blueprint} sessions={props.sessions} touch={props.touch} />
      {node.role === "chapter" && node.chapter !== null && !props.touch && <ChapterDropTargets chapterKey={node.key} chapter={node.chapter} title={title} />}
      {node.card && <CardEditor title={title} question={node.card.question} conclusion={node.card.conclusion} touch={props.touch} onChange={(value) => props.handlers.onConclusion(node.key, value)} />}
    </div>
  );
}

function TreePreview(props: BlueprintPreviewProps) {
  const t = useF14T();
  const { blueprint, sessions } = props;
  const inTree = blueprint.nodes.filter((node) => node.role !== "standalone");
  const separate = blueprint.nodes.filter((node) => node.role === "standalone");
  const position = (key: string) => blueprint.nodes.findIndex((node) => node.key === key);
  return (
    <div className="flex flex-col gap-3">
      <ol aria-label={t("assembly.preview")} className="relative m-0 flex list-none flex-col gap-2.5 p-0 pl-6">
        <span aria-hidden className="absolute top-3 bottom-5 left-2.5 w-0.5 rounded-full bg-tg-primary" />
        {inTree.map((node) => {
          const branch = node.role !== "chapter";
          return (
            <li key={node.key} className={cx("relative", branch && "ml-4")}>
              {branch ? (
                <span aria-hidden className="absolute top-0 -left-5.5 h-5 w-5 rounded-bl-tg border-b-2 border-l-2 border-tg-branch-merged" />
              ) : (
                <span aria-hidden className="absolute top-3 -left-5 size-3 rounded-full border-2 border-tg-primary bg-tg-surface" />
              )}
              <NodeBox node={node} session={sessions.get(node.key)!} props={props} index={position(node.key)} count={blueprint.nodes.length} />
            </li>
          );
        })}
      </ol>
      <StandaloneDrop>
        {separate.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {separate.map((node) => (
            <li key={node.key} className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1 text-tg-xs text-tg-muted">
                <ExternalLink aria-hidden className="size-3.5" />
                {props.relations ? t("role.standaloneSub") : t("role.standaloneSubNoRelations")}
              </span>
              <NodeBox node={node} session={sessions.get(node.key)!} props={props} index={position(node.key)} count={blueprint.nodes.length} />
            </li>
          ))}
        </ul>
        )}
      </StandaloneDrop>
    </div>
  );
}

function BatchPreview(props: BlueprintPreviewProps) {
  const t = useF14T();
  const { blueprint, sessions } = props;
  return (
    <section aria-label={t("assembly.batchBox")} className="flex flex-col gap-2 rounded-tg border border-dashed border-tg-border-strong bg-tg-surface-sunken p-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-tg-xs">
        <FolderOpen aria-hidden className="size-4 text-tg-muted" />
        <span className="font-semibold text-tg-foreground-strong">{props.folder || t("assembly.folderNone")}</span>
        {props.tags.map((tag) => (
          <span key={tag} className="rounded-tg-full border border-tg-border bg-tg-surface px-1.5 text-tg-foreground">
            #{tag}
          </span>
        ))}
        <button type="button" aria-expanded={props.organize !== null} onClick={props.onOrganize} className="ml-auto rounded-tg-sm px-1 font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
          {t("assembly.folderTags")}
        </button>
      </div>
      {props.organize}
      <ol aria-label={t("assembly.preview")} className="m-0 flex list-none flex-col p-0">
        {blueprint.nodes.map((node, index) => {
          const session = sessions.get(node.key)!;
          return (
            <li key={node.key} className="flex flex-col">
              {index > 0 && (
                <span className="inline-flex h-5 items-center gap-1 pl-5 text-[0.6875rem] text-tg-muted">
                  {props.relations ? (
                    <>
                      <Link2 aria-hidden className="size-3" />
                      {t("assembly.related")}
                    </>
                  ) : null}
                </span>
              )}
              <div data-tg-blueprint-node={node.key} className="flex items-center gap-2 rounded-tg-sm border border-tg-border bg-tg-surface px-2.5 py-2 text-tg-sm">
                <PreviewHandle nodeKey={node.key} title={session.conversation.title || t("import.untitled")} props={props} />
                <List aria-hidden className="size-3.5 shrink-0 text-tg-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-tg-foreground-strong">{session.conversation.title || t("import.untitled")}</span>
                <MergedCount n={props.handlers.mergedCountOf(node.key)} />
                <span className="shrink-0 font-tg-mono text-tg-xs text-tg-muted">
                  {batchWhen(session, t)}・{t("assembly.messages", { n: node.messages })}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {!props.relations && <p className="m-0 text-tg-xs text-tg-muted">{t("assembly.notRelated")}</p>}
    </section>
  );
}

export function BlueprintPreview(props: BlueprintPreviewProps) {
  return (
    <div className="rounded-tg border border-tg-border bg-tg-surface-sunken bg-[radial-gradient(var(--tg-border)_1px,transparent_1px)] [background-size:12px_12px] p-3">
      {props.blueprint.mode === "batch" ? <BatchPreview {...props} /> : <TreePreview {...props} />}
    </div>
  );
}
