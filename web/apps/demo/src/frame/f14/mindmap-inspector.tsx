/**
 * F17 MindMapInspector (S4): the selected node's details, 460 wide on the
 * right (a 300px panel under the canvas on a phone, 380 for a branch):
 * its role and time, rounds and messages, its title; the four roles in one
 * click (設為主幹 §｜掛為支線｜開放支線｜獨立對話); for a branch 掛載於 (the
 * chapter, and the round of it to fork after) and, when its fork round was
 * moved away, the warning with 確認分岔點; 合併進… (a chapter); the analysis'
 * reason; a merged branch's card; and its rounds (mindmap-turns.tsx). On a
 * phone with the turn order on, the panel lists the original order instead.
 */
import { extractSessionRounds, isBranchRole, MINDMAP_ROOT_KEY, type NodeRole } from "@tangent/client";
import { Bookmark, CornerDownRight, ExternalLink, Flag, GitBranch, List, Sparkles, TriangleAlert } from "lucide-react";
import { useId, useMemo, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "../cx";
import { focusIfLost } from "./ai-node-panel";
import type { AiTreeView } from "./use-ai-tree";
import { useF14T } from "./f14-messages";
import { useF17T, type F17T } from "./f17-messages";
import type { MindMapModelNode } from "./mindmap-model";
import { TraceList } from "./mindmap-trace-list";
import { TurnList, turnItems } from "./mindmap-turns";
import type { Assembly } from "./use-assembly";
import type { MindMap } from "./use-mindmap";

export interface MindMapInspectorProps {
  map: MindMap;
  assembly: Assembly;
  view: AiTreeView | null;
  touch: boolean;
  heading: RefObject<HTMLHeadingElement | null>;
  root: { title: string };
  /** The main line's settings, under the root's details. */
  mainLine: ReactNode;
}

const ROLES: ReadonlyArray<{ role: NodeRole; key: "ins.setChapter" | "ins.setBranch" | "ins.setOpen" | "ins.setSolo"; icon: ReactNode }> = [
  { role: "chapter", key: "ins.setChapter", icon: <Bookmark aria-hidden className="size-3 shrink-0" /> },
  { role: "merged_branch", key: "ins.setBranch", icon: <CornerDownRight aria-hidden className="size-3 shrink-0" /> },
  { role: "open_branch", key: "ins.setOpen", icon: <GitBranch aria-hidden className="size-3 shrink-0" /> },
  { role: "standalone", key: "ins.setSolo", icon: <ExternalLink aria-hidden className="size-3 shrink-0" /> },
];
const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function rolePill(t: F17T, node: MindMapModelNode): { text: string; icon: ReactNode; tone: string } {
  if (node.role === "chapter") return { text: t("ins.role.chapter", { n: node.chapter ?? "" }), icon: <Bookmark aria-hidden className="size-3" />, tone: "bg-tg-primary text-tg-primary-foreground" };
  if (node.role === "standalone") return { text: t("ins.role.solo"), icon: <ExternalLink aria-hidden className="size-3" />, tone: "bg-tg-surface-sunken text-tg-foreground" };
  return { text: node.role === "merged_branch" ? t("ins.role.merged") : t("ins.role.open"), icon: <CornerDownRight aria-hidden className="size-3" />, tone: "bg-tg-surface-sunken text-tg-foreground" };
}

function RoleRadios({ node, props }: { node: MindMapModelNode; props: MindMapInspectorProps }) {
  const t = useF17T();
  const reasonId = useId();
  const { assembly, view, touch } = props;
  const chapters = assembly.blueprint.nodes.filter((item) => item.role === "chapter").length;
  // The main line keeps at least one chapter (a batch has none to keep).
  const locked = node.role === "chapter" && chapters <= 1 && assembly.blueprint.mode !== "batch";
  const usable = (role: NodeRole) => !locked || role === "chapter";
  const choose = (role: NodeRole) => {
    if (!usable(role) || role === node.role) return;
    if (view) view.setRole(node.key, role);
    else assembly.setRole(node.key, role);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const group = event.currentTarget;
    const choices = ROLES.filter((item) => usable(item.role));
    const at = choices.findIndex((item) => item.role === node.role);
    const next = choices[(at + step + choices.length) % choices.length]!;
    choose(next.role);
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-tg-inspector-role="${next.role}"]`)?.focus());
  };
  return (
    <div role="radiogroup" aria-label={t("ins.roles")} aria-describedby={locked ? reasonId : undefined} onKeyDown={onKeyDown} className={cx("grid gap-1", touch ? "grid-cols-2" : "grid-cols-4")}>
      {ROLES.map((item) => {
        const on = item.role === node.role;
        return (
          <button
            key={item.role}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={!usable(item.role) || undefined}
            tabIndex={on ? 0 : -1}
            data-tg-inspector-role={item.role}
            onClick={() => choose(item.role)}
            className={cx(
              "flex items-center justify-center gap-1.5 rounded-tg-sm border px-1.5 text-tg-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring aria-disabled:opacity-45",
              touch ? "min-h-11" : "min-h-7.5",
              on ? "border-tg-primary bg-tg-primary-soft font-semibold text-tg-primary-text" : "border-tg-border-input bg-tg-surface text-tg-foreground hover:bg-tg-accent",
            )}
          >
            {item.icon}
            {t(item.key)}
          </button>
        );
      })}
      {locked && (
        <span id={reasonId} className="col-span-full text-tg-xs text-tg-muted">
          {t("ins.roleBlocked")}
        </span>
      )}
    </div>
  );
}

const selectClass = (touch: boolean) => cx("min-w-0 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1.5 text-tg-xs text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-11" : "h-7");

/** 掛載於 §k ▾・第 #n 輪之後 ▾ (only that chapter's rounds). */
function AttachRow({ node, props }: { node: MindMapModelNode; props: MindMapInspectorProps }) {
  const t = useF17T();
  const { assembly, view, touch, map } = props;
  const chapters = map.model.nodes.filter((item) => item.role === "chapter" && item.key !== node.key);
  const host = node.attachTo ? map.model.byKey.get(node.attachTo) : undefined;
  const hang = (chapterKey: string) => {
    if (!chapterKey) return;
    if (view) view.hangOn(node.key, chapterKey);
    else assembly.setRoleBatch([node.key], node.role, chapterKey);
  };
  // Analyzed: the chapter's units (#n); before: the rounds of the chapter's own session.
  const hostSession = host ? assembly.byKey.get(host.key) : undefined;
  const rounds = !view && hostSession ? extractSessionRounds(hostSession, assembly.messageEdits(hostSession.key).removed) : [];
  const anchors = view && host ? host.units.map((unit, index) => ({ value: unit, label: t("ins.afterTurn", { turn: `#${host.turns[index]}` }), on: host.turns[index] === node.forkTurn })) : rounds.map((round) => ({ value: round.anchorId, label: t("ins.afterRound", { n: round.n }), on: round.n === node.forkRound }));
  const current = anchors.find((anchor) => anchor.on)?.value ?? "";
  const anchor = (value: string) => {
    if (!value || !host) return;
    if (view) view.anchorAfter(node.key, value);
    else assembly.setAttach(node.key, { sessionKey: host.key, externalId: value });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-tg-xs">
      <span className="shrink-0 text-tg-muted">{t("ins.attachTo")}</span>
      <select data-tg-inspector-attach="" aria-label={t("ins.attachChapter", { title: node.title })} value={host?.key ?? ""} onChange={(event) => hang(event.target.value)} className={cx(selectClass(touch), "max-w-60 flex-1 font-tg-mono")}>
        {!host && <option value="">—</option>}
        {chapters.map((chapter) => (
          <option key={chapter.key} value={chapter.key}>
            §{chapter.chapter} {chapter.title}
          </option>
        ))}
      </select>
      {anchors.length > 0 && (
        <select data-tg-inspector-anchor="" aria-label={t("ins.afterLabel", { title: node.title })} value={current} onChange={(event) => anchor(event.target.value)} className={cx(selectClass(touch), "shrink-0")}>
          {!current && <option value="">—</option>}
          {anchors.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** 合併進… (a chapter): the drop's 「合併進 §k」 without dragging. */
function MergeInto({ node, props }: { node: MindMapModelNode; props: MindMapInspectorProps }) {
  const t = useF17T();
  const { assembly, map, touch } = props;
  const chapters = map.model.nodes.filter((item) => item.role === "chapter" && item.key !== node.key);
  if (chapters.length === 0) return null;
  return (
    <select
      data-tg-inspector-merge=""
      aria-label={t("ins.mergeIntoLabel", { title: node.title })}
      value=""
      onChange={(event) => {
        const target = event.target.value;
        if (target && assembly.mergeSessions([node.key, target], target)) map.select(target);
      }}
      className={cx(selectClass(touch), "w-fit")}
    >
      <option value="">{t("ins.mergeInto")}</option>
      {chapters.map((chapter) => (
        <option key={chapter.key} value={chapter.key}>
          §{chapter.chapter} {chapter.title}
        </option>
      ))}
    </select>
  );
}

function ForkNotice({ node, view }: { node: MindMapModelNode; view: AiTreeView | null }) {
  const t = useF17T();
  if (!node.forkMoved || !view) return null;
  return (
    <div data-tg-inspector-fork-moved="" className="flex flex-wrap items-center gap-2 rounded-tg-sm border border-tg-warning bg-tg-warning-soft px-2 py-1.5 text-tg-xs text-tg-foreground">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-tg-warning" />
      <span className="min-w-0 flex-1">{t("ins.forkMoved", { turn: node.forkTurn ? `#${node.forkTurn}` : "—" })}</span>
      <button type="button" onClick={() => view.confirmFork(node.key)} className="rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 py-0.5 font-medium hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11">
        {t("ins.forkConfirm")}
      </button>
    </div>
  );
}

function CardBox({ node, assembly }: { node: MindMapModelNode; assembly: Assembly }) {
  const t = useF17T();
  const f14 = useF14T();
  const errorId = useId();
  if (node.role !== "merged_branch" || !node.card) return null;
  const empty = node.card.conclusion.trim() === "";
  return (
    <div data-tg-inspector-card="" className="flex flex-col gap-1.5 rounded-tg border border-tg-card-border bg-tg-card px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-tg-xs font-semibold text-tg-foreground-strong">
        <Flag aria-hidden className="size-3.5 text-tg-leaf-conclusion" />
        {t("ins.card")}
      </span>
      <span className="text-tg-xs text-tg-muted">{t("ins.cardQuestion", { text: node.card.question })}</span>
      <textarea
        aria-label={t("ins.cardField", { title: node.title })}
        aria-invalid={empty || undefined}
        aria-describedby={empty ? errorId : undefined}
        value={node.card.conclusion}
        rows={3}
        maxLength={2000}
        onChange={(event) => assembly.setConclusion(node.key, event.target.value)}
        className={cx("w-full resize-y rounded-tg-sm border bg-tg-surface px-2.5 py-2 text-tg-sm leading-normal text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", empty ? "border-tg-destructive" : "border-tg-border-input")}
      />
      {empty && (
        <span id={errorId} className="text-tg-xs text-tg-destructive">
          {f14("assembly.cardEmpty")}
        </span>
      )}
    </div>
  );
}

function NodeDetails({ node, props }: { node: MindMapModelNode; props: MindMapInspectorProps }) {
  const t = useF17T();
  const { map, assembly, view, touch, heading } = props;
  const pill = rolePill(t, node);
  const { orderedOriginal, byKey } = assembly;
  const own = assembly.state.edits.messages;
  const shown = assembly.edits.messages;
  // Only when the node or its sessions change (not on every zoom step or selection elsewhere).
  const items = useMemo(
    () =>
      turnItems(
        node,
        (key) => orderedOriginal.find((session) => session.key === key) ?? byKey.get(key),
        (key) => (node.units.length > 0 ? own?.[key]?.removed : shown?.[key]?.removed) ?? new Set<string>(),
      ),
    [node, orderedOriginal, byKey, own, shown],
  );
  const pad = touch ? "px-4" : "px-4.5";
  return (
    <>
      <div className={cx("flex shrink-0 flex-col gap-2 border-b border-tg-border pb-3", pad, touch ? "pt-1.5" : "pt-3.5")}>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={cx("inline-flex h-5.5 items-center gap-1 rounded-tg-full px-2 text-[0.6875rem] font-semibold whitespace-nowrap", pill.tone)}>
            {pill.icon}
            {pill.text}
          </span>
          <span className="font-tg-mono text-[0.6875rem] text-tg-muted">{t("ins.meta", { time: node.when || "—", t: node.units.length || node.rounds, m: node.messages })}</span>
        </span>
        <h3 ref={heading} tabIndex={-1} data-tg-inspector-title="" className="m-0 text-tg-md leading-snug font-semibold text-tg-foreground-strong focus-visible:outline-2 focus-visible:outline-tg-ring">
          {node.title}
        </h3>
        <RoleRadios node={node} props={props} />
        {isBranchRole(node.role) && <AttachRow node={node} props={props} />}
        <ForkNotice node={node} view={view} />
        <MergeInto node={node} props={props} />
      </div>
      <div className={cx("flex min-h-0 flex-1 flex-col gap-3 overflow-auto py-3.5", pad)}>
        {node.reason && (
          <p data-tg-inspector-reason="" className="m-0 flex items-start gap-2 rounded-tg border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-2.5 py-2 text-tg-xs">
            <Sparkles aria-hidden className="mt-0.5 size-3.5 shrink-0 text-tg-suggestion" />
            <span>
              <b className="font-semibold">{t("ins.reason")}</b>
              {node.reason}
            </span>
          </p>
        )}
        <CardBox node={node} assembly={assembly} />
        <TurnList node={node} items={items} map={map} view={view} touch={touch} onMoved={() => focusIfLost("[data-tg-inspector-title]")} />
      </div>
    </>
  );
}

function RootDetails({ props }: { props: MindMapInspectorProps }) {
  const t = useF17T();
  const { map, heading, root, touch, mainLine } = props;
  return (
    <div data-tg-inspector-root="" className={cx("flex min-h-0 flex-col gap-2 overflow-auto py-3.5", touch ? "px-4" : "px-4.5")}>
      <span className="inline-flex h-5.5 w-fit items-center gap-1 rounded-tg-full bg-tg-surface-sunken px-2 text-[0.6875rem] font-semibold">
        <List aria-hidden className="size-3" />
        {t("ins.role.root")}
      </span>
      <h3 ref={heading} tabIndex={-1} className="m-0 text-tg-md font-semibold text-tg-foreground-strong focus-visible:outline-2 focus-visible:outline-tg-ring">
        {root.title}
      </h3>
      <p className="m-0 font-tg-mono text-tg-xs text-tg-muted">{t("map.rootStats", map.model.stats)}</p>
      <p className="m-0 text-tg-xs text-tg-muted">{t("ins.rootHint")}</p>
      {mainLine}
    </div>
  );
}

export function MindMapInspector(props: MindMapInspectorProps) {
  const t = useF17T();
  const { map, touch } = props;
  const node = map.node;
  const isRoot = map.selected === MINDMAP_ROOT_KEY;
  const body = touch && map.trace ? <TraceList map={map} assembly={props.assembly} /> : isRoot ? <RootDetails props={props} /> : node ? <NodeDetails node={node} props={props} /> : <p className="m-0 p-4 text-tg-sm text-tg-muted">{t("map.hint")}</p>;
  return (
    <aside
      aria-label={t("ins.label")}
      data-tg-mindmap-inspector={map.selected ?? ""}
      className={cx("flex flex-col bg-tg-surface", touch ? "shrink-0 border-t border-tg-border-strong shadow-[0_-8px_20px_-12px_rgba(0,0,0,0.25)]" : "min-h-0 w-[460px] shrink-0 border-l border-tg-border")}
    >
      {touch && <span aria-hidden className="mx-auto mt-1.5 h-1 w-9 shrink-0 rounded-full bg-tg-border-strong" />}
      {body}
    </aside>
  );
}

