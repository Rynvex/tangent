/**
 * F16.2: fine-tuning an analyzed tree on the preview's nodes: one round moved
 * to another node or split out (the plan applied again), a branch hung on
 * another chapter, one-click roles, and which nodes show their rounds.
 * F17: a branch whose fork round was moved away is re-anchored and flagged
 * (decision #6) until the user confirms it or its fork changes any other way
 * (another round, another chapter, a drop, the list's menu, another role):
 * the flag remembers the point it was re-anchored on and holds only while
 * the branch still hangs there.
 */
import { isBranchRole, type AttachPoint, type NodeRole } from "@tangent/client";
import { useMemo, useState } from "react";
import { applyAnalysis, movedPlan, unitsOfNode } from "./ai-tree-plan";
import { useF14T } from "./f14-messages";
import { useF162T } from "./f162-messages";
import { useF17T } from "./f17-messages";
import type { Assembly } from "./use-assembly";
import type { AiSessions } from "./use-ai-tree";

const toggled = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => (set.has(key) ? new Set([...set].filter((item) => item !== key)) : new Set([...set, key]));
const samePoint = (a: AttachPoint | undefined, b: AttachPoint | undefined) => a !== undefined && b !== undefined && a.sessionKey === b.sessionKey && a.externalId === b.externalId;

export function useAiFineTune(ai: AiSessions, assembly: Assembly) {
  const t = useF162T();
  const f14 = useF14T();
  const f17 = useF17T();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Re-anchored branches and the point each was put on (decision #6).
  const [reanchored, setReanchored] = useState<ReadonlyMap<string, AttachPoint>>(new Map());
  const roleOf = (key: string): NodeRole => assembly.blueprint.nodes.find((node) => node.key === key)?.role ?? "chapter";
  const numberOf = (unitKey: string) => (ai.analysis?.units.findIndex((unit) => unit.key === unitKey) ?? -1) + 1;
  const forget = (key: string) => setReanchored((current) => (current.has(key) ? new Map([...current].filter(([item]) => item !== key)) : current));
  const attach = assembly.state.edits.attach;
  const nodes = assembly.blueprint.nodes;
  /** Flagged while the branch is still a branch hanging where it was re-anchored. */
  const forkMoved = useMemo(() => {
    const branches = new Set(nodes.filter((node) => isBranchRole(node.role)).map((node) => node.key));
    return new Set([...reanchored].filter(([key, point]) => branches.has(key) && samePoint(attach?.[key], point)).map(([key]) => key));
  }, [reanchored, attach, nodes]);

  /** A branch hangs after `unitKey`'s last reply (a unit of the chapter it hangs on). */
  const attachAfterUnit = (nodeKey: string, unitKey: string): boolean => {
    const session = assembly.orderedOriginal.find((item) => item.key === unitKey);
    const message = session ? ([...session.conversation.messages].reverse().find((item) => item.role === "assistant") ?? session.conversation.messages.at(-1)) : undefined;
    if (!session || !message) return false;
    const point: AttachPoint = { sessionKey: session.key, externalId: message.externalId };
    assembly.setAttach(nodeKey, point);
    return true;
  };

  /** One round moved to another node (its visible key) or split out (NEW_BRANCH / NEW_STANDALONE); the plan applied again. */
  const moveUnit = (unitKey: string, target: string) => {
    const analysis = ai.analysis;
    if (!analysis) return;
    const { plan, moved } = movedPlan(analysis, { ordered: assembly.ordered, state: assembly.state, roleOf }, unitKey, target);
    const applied = applyAnalysis(analysis, plan, assembly.orderedOriginal, assembly.state.edits.messages);
    ai.setAnalysis(applied.analysis);
    // The mode the user chose stays, unless the tree now has a branch only the tree can hold.
    const needsTree = plan.nodes.some((node) => node.role === "merged_branch" || node.role === "open_branch");
    assembly.restore({ ...applied.state, mode: needsTree ? "tree" : assembly.mode });
    const into = plan.nodes.find((node) => node.unitKeys.includes(unitKey));
    if (into) setExpanded((current) => new Set([...current, into.key]));
    const branches = new Set(plan.nodes.filter((node) => node.role === "merged_branch" || node.role === "open_branch").map((node) => node.key));
    const points = moved.flatMap((key) => {
      const point = applied.state.edits.attach?.[key];
      return branches.has(key) && point ? [[key, point] as const] : [];
    });
    if (points.length > 0) setReanchored((current) => new Map([...current, ...points]));
    const title = into ? (applied.analysis.titles[into.key] ?? into.title) : "";
    const said = into && into.unitKeys.length > 1 ? t("ai.moved", { n: numberOf(unitKey), title }) : t("ai.split", { n: numberOf(unitKey) });
    const fork = plan.nodes.find((node) => node.key === moved[0]);
    const forkSaid = fork?.attachAfterUnitKey ? ` ${f17("move.forkStatus", { title: applied.analysis.titles[fork.key] ?? fork.title, pos: `#${numberOf(fork.attachAfterUnitKey)}` })}` : "";
    assembly.say(`${said}${forkSaid}`);
  };

  /** A branch hung on another chapter, after that chapter's last round before it (else its first round). */
  const hangOn = (nodeKey: string, chapterKey: string) => {
    const analysis = ai.analysis;
    if (!analysis) return;
    const first = numberOf(unitsOfNode(analysis, assembly.state.merges, nodeKey)[0]?.key ?? "");
    const rounds = unitsOfNode(analysis, assembly.state.merges, chapterKey);
    const unit = rounds.filter((item) => numberOf(item.key) < first).at(-1) ?? rounds[0];
    if (!unit || !attachAfterUnit(nodeKey, unit.key)) return;
    const chapter = assembly.blueprint.nodes.find((node) => node.key === chapterKey)?.chapter;
    if (chapter) assembly.say(f14("f161.attached", { n: 1, c: chapter }));
  };

  return {
    clearExpanded: () => {
      setExpanded(new Set());
      setReanchored(new Map());
    },
    view: ai.analysis
      ? {
          analysis: ai.analysis,
          merges: assembly.state.merges,
          numberOf,
          moveUnit,
          hangOn,
          /** F17: the branch forks after another round of its chapter (`unitKey`); the fork is the user's now. */
          anchorAfter: (nodeKey: string, unitKey: string) => {
            attachAfterUnit(nodeKey, unitKey);
          },
          setRole: (key: string, role: NodeRole) => assembly.setRole(key, role),
          /** F17: branches whose fork round was moved away, until confirmed (decision #6). */
          forkMoved,
          confirmFork: forget,
          expanded,
          toggle: (key: string) => setExpanded((current) => toggled(current, key)),
        }
      : null,
  };
}

export type AiTreeView = NonNullable<ReturnType<typeof useAiFineTune>["view"]>;
