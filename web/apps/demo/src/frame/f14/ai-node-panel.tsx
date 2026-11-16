/**
 * F16.2 AiNodePanel: what the analysis says on one node of the preview,
 * under its title: 「跨段整合 N 輪（#1, #3, #5）」 and the reason, one-click
 * roles (and 「掛在：§ ▾」 for a branch), and 「查看／微調各輪問答」 listing
 * the node's rounds, each with a menu to move it to another node or split
 * it out (no dragging). Nothing before an analysis.
 */
import { mergeMembers, NEW_BRANCH, NEW_STANDALONE, type AssemblyBlueprint, type BlueprintNode, type ImportAnalyzeUnit, type NodeRole, type TimelineSession } from "@tangent/client";
import { Button } from "@tangent/react";
import { ChevronRight, Layers } from "lucide-react";
import { useId } from "react";
import { cx } from "../cx";
import { planNodeOf, unitsOfNode } from "./ai-tree-plan";
import { useAiTreeView } from "./ai-tree-context";
import { useF162T, type F162T } from "./f162-messages";
import type { AiTreeView } from "./use-ai-tree";

/** Titles in the menus stay short. */
const MENU_TITLE_RUNES = 24;

const shortTitle = (text: string) => (Array.from(text).length <= MENU_TITLE_RUNES ? text : `${Array.from(text).slice(0, MENU_TITLE_RUNES - 1).join("")}…`);

export interface AiNodePanelProps {
  node: BlueprintNode;
  title: string;
  blueprint: AssemblyBlueprint;
  sessions: ReadonlyMap<string, TimelineSession>;
  touch: boolean;
}

/** "§1 標題", "↳ 標題" or "獨立對話：標題" for a node of the preview. */
function nodeLabel(node: BlueprintNode, sessions: ReadonlyMap<string, TimelineSession>, t: F162T): string {
  const title = shortTitle(sessions.get(node.key)?.conversation.title ?? "");
  if (node.role === "chapter") return t("ai.node.chapter", { n: node.chapter ?? "", title });
  return node.role === "standalone" ? t("ai.node.standalone", { title }) : t("ai.node.branch", { title });
}

/**
 * After a change that remounts the control in use, focus `selector` again: when focus fell to the page or to the
 * dialog itself (its focus trap takes it when the focused element goes).
 */
export function focusIfLost(selector: string): void {
  const attempt = () => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !document.contains(active) || active.getAttribute("role") === "dialog";
    if (lost) document.querySelector<HTMLElement>(selector)?.focus();
  };
  // Once the change is drawn, and again after the dialog's focus trap has reacted to the removed element.
  requestAnimationFrame(attempt);
  window.setTimeout(attempt, FOCUS_RETRY_MS);
}

/** When the dialog's focus trap has moved focus to itself after a focused element went. */
const FOCUS_RETRY_MS = 120;

const toggleOf = (key: string) => `[data-tg-node-units-toggle="${CSS.escape(key)}"]`;

function RoleActions({ view, props }: { view: AiTreeView; props: AiNodePanelProps }) {
  const t = useF162T();
  const { node, blueprint, sessions, title, touch } = props;
  const chapters = blueprint.nodes.filter((item) => item.role === "chapter" && item.key !== node.key);
  const branch = node.role === "merged_branch" || node.role === "open_branch";
  const roles: ReadonlyArray<{ role: NodeRole; label: string }> = [
    ...(node.role !== "chapter" ? [{ role: "chapter" as const, label: t("ai.toChapter") }] : []),
    ...(!branch ? [{ role: "merged_branch" as const, label: t("ai.toBranch") }] : []),
    ...(node.role !== "standalone" ? [{ role: "standalone" as const, label: t("ai.toStandalone") }] : []),
  ];
  // The chapter the branch hangs on now: the one holding the attach point's session (merged or not).
  const point = node.attach?.point.sessionKey;
  const hostKey = (point && chapters.find((chapter) => chapter.key === point || mergeMembers(view.merges, chapter.key).includes(point))?.key) || "";
  const setRole = (role: NodeRole) => {
    view.setRole(node.key, role);
    // The node may move between the tree and the separate list: its rounds button takes focus back.
    focusIfLost(toggleOf(node.key));
  };
  return (
    <div role="group" aria-label={title} className="flex flex-wrap items-center gap-1.5">
      {branch && chapters.length > 0 && (
        <label className="flex min-w-0 items-center gap-1 text-tg-xs text-tg-muted">
          {t("ai.hangOn")}
          <select
            data-tg-ai-hang-on={node.key}
            aria-label={t("ai.hangOnLabel", { title })}
            value={hostKey}
            onChange={(event) => event.target.value && view.hangOn(node.key, event.target.value)}
            className={cx("min-w-0 max-w-44 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1 text-tg-xs text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-10" : "h-6")}
          >
            {!hostKey && <option value="">—</option>}
            {chapters.map((chapter) => (
              <option key={chapter.key} value={chapter.key}>
                {nodeLabel(chapter, sessions, t)}
              </option>
            ))}
          </select>
        </label>
      )}
      {roles.map(({ role, label }) => (
        <Button key={role} size="sm" data-tg-ai-role={role} onClick={() => setRole(role)} className={cx(touch ? "h-10" : "h-6 px-2")}>
          {label}
        </Button>
      ))}
    </div>
  );
}

function UnitRow({ unit, view, props }: { unit: ImportAnalyzeUnit; view: AiTreeView; props: AiNodePanelProps }) {
  const t = useF162T();
  const { node, blueprint, sessions, touch } = props;
  const n = view.numberOf(unit.key);
  const others = blueprint.nodes.filter((item) => item.key !== node.key);
  return (
    <li data-tg-ai-unit={unit.key} className="flex items-center gap-2 rounded-tg-sm border border-tg-border bg-tg-surface-sunken px-2 py-1">
      <span className="shrink-0 font-tg-mono text-tg-xs text-tg-muted">#{n}</span>
      <span className={cx("min-w-0 flex-1 text-tg-xs text-tg-foreground", touch ? "line-clamp-2 break-words" : "truncate")} title={unit.question}>
        {t("ai.unitQuestion", { text: unit.question })}
      </span>
      <select
        data-tg-move-unit={unit.key}
        aria-label={t("ai.moveUnit", { n })}
        value=""
        onChange={(event) => {
          const target = event.target.value;
          if (!target) return;
          view.moveUnit(unit.key, target);
          focusIfLost(`[data-tg-move-unit="${CSS.escape(unit.key)}"]`);
        }}
        className={cx("w-28 shrink-0 rounded-tg-sm border border-tg-border-input bg-tg-surface px-1 text-tg-xs text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "h-10" : "h-6")}
      >
        <option value="">{t("ai.movePlaceholder")}</option>
        {others.length > 0 && (
          <optgroup label={t("ai.moveGroup")}>
            {others.map((item) => (
              <option key={item.key} value={item.key}>
                {nodeLabel(item, sessions, t)}
              </option>
            ))}
          </optgroup>
        )}
        <option value={NEW_BRANCH}>{t("ai.moveNewBranch")}</option>
        <option value={NEW_STANDALONE}>{t("ai.moveNewStandalone")}</option>
      </select>
    </li>
  );
}

export function AiNodePanel(props: AiNodePanelProps) {
  const t = useF162T();
  const view = useAiTreeView();
  const listId = useId();
  if (!view) return null;
  const { node, title, touch } = props;
  const units = unitsOfNode(view.analysis, view.merges, node.key);
  if (units.length === 0) return null;
  const reason = planNodeOf(view.analysis, view.merges, node.key)?.reason;
  const open = view.expanded.has(node.key);
  return (
    <div data-tg-ai-node={node.key} className="flex flex-col gap-1.5">
      {units.length > 1 && (
        <p data-tg-ai-units-badge="" className="m-0 inline-flex w-fit max-w-full items-center gap-1 rounded-tg-full bg-tg-primary-soft px-2 text-[0.6875rem] font-medium text-tg-primary-text">
          <Layers aria-hidden className="size-3 shrink-0" />
          {t("ai.badge", { n: units.length, list: units.map((unit) => `#${view.numberOf(unit.key)}`).join(", ") })}
        </p>
      )}
      {reason && (
        <p data-tg-ai-reason="" className="m-0 text-tg-xs text-tg-muted">
          {t("ai.reason", { text: reason })}
        </p>
      )}
      <RoleActions view={view} props={props} />
      <button
        type="button"
        data-tg-node-units-toggle={node.key}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t("ai.unitsToggleLabel", { title })}
        onClick={() => view.toggle(node.key)}
        className={cx("inline-flex w-fit items-center gap-1 rounded-tg-sm px-1 text-tg-xs font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "min-h-11" : "h-6")}
      >
        <ChevronRight aria-hidden className={cx("size-3.5 transition-transform", open && "rotate-90")} />
        {t("ai.unitsToggle", { n: units.length })}
      </button>
      {open && (
        <ol id={listId} className="m-0 flex list-none flex-col gap-1 p-0">
          {units.map((unit) => (
            <UnitRow key={unit.key} unit={unit} view={view} props={props} />
          ))}
        </ol>
      )}
    </div>
  );
}
