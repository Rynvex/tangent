import { isFeatureOn, selectionAction, type BranchView, type SelectionProblem } from "@tangent/client";
import { Combine, Group as GroupIcon } from "lucide-react";
import { Button } from "../components/button";
import { useReadOnly } from "../data/live-hooks";
import { useGroups } from "../data/group-hooks";
import { useCapabilities } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";

const PROBLEM_KEYS = {
  tooFew: "selection.problem.tooFew",
  tooMany: "selection.problem.tooMany",
  mixed: "selection.problem.mixed",
  promoted: "selection.problem.promoted",
  noEnding: "selection.problem.noEnding",
  inGroup: "selection.problem.inGroup",
  notSiblings: "selection.problem.notSiblings",
  aside: "selection.problem.aside",
} as const satisfies Record<SelectionProblem, string>;

export interface SelectionActionsProps {
  rootLineId: string;
  /** The branches selected in the outline or the map. */
  selected: readonly BranchView[];
  /** The host opens the group or combine dialog with the selection. */
  onAction: (action: "group" | "combine") => void;
}

/**
 * Under a multi-selection (C2): the one action it allows — 建立群組 for
 * ended branches, 合併成一條支線 for open siblings — or why neither. Nothing
 * while the group feature is off or for a viewer.
 */
export function SelectionActions({ rootLineId, selected, onAction }: SelectionActionsProps) {
  const t = useP2T();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const on = isFeatureOn(capabilities.data, "group");
  const groups = useGroups(rootLineId, on);
  if (!on || readOnly || selected.length === 0) return null;
  const result = selectionAction(selected, groups.data?.groups ?? []);
  if (result.action === null) return <span className="text-tg-xs text-tg-muted">{t(PROBLEM_KEYS[result.reason])}</span>;
  if (result.action === "group") {
    return (
      <Button size="sm" variant="primary" icon={<GroupIcon aria-hidden className="size-3" />} onClick={() => onAction("group")}>
        {t("group.create")}
      </Button>
    );
  }
  return (
    <Button size="sm" variant="primary" icon={<Combine aria-hidden className="size-3" />} onClick={() => onAction("combine")}>
      {t("selection.combine")}
    </Button>
  );
}
