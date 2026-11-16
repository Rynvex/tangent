import { isFeatureOn, selectionAction, type BranchView, type Group } from "@tangent/client";
import { useState } from "react";
import { useGroups } from "../data/group-hooks";
import { useReadOnly } from "../data/live-hooks";
import { useCapabilities } from "../data/queries";
import type { MapGroupsProps } from "../structure/group-layer";
import type { GroupFormMode } from "./group-form-dialog";
import { SelectionActions } from "./selection-actions";

const NO_GROUPS: readonly Group[] = [];

export type SelectionHandler = (action: GroupFormMode, selected: readonly BranchView[]) => void;

/** The selection's actions as the outline and the map render them (C2); undefined for a viewer or with the group feature off. */
export function useSelectionActions(rootLineId: string, onAction: SelectionHandler) {
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const on = isFeatureOn(capabilities.data, "group");
  const groups = useGroups(rootLineId, on);
  if (!on || readOnly) return undefined;
  return {
    render: (selected: readonly BranchView[], done: () => void) => (
      <SelectionActions
        rootLineId={rootLineId}
        selected={selected}
        onAction={(action) => {
          done();
          onAction(action, selected);
        }}
      />
    ),
    /** G: the action the selection allows, if any (the bar says why not). */
    onKey: (selected: readonly BranchView[], done: () => void) => {
      const result = selectionAction(selected, groups.data?.groups ?? NO_GROUPS);
      if (result.action === null) return;
      done();
      onAction(result.action, selected);
    },
  };
}

/** The branch map's 群組 layer fed from the server (C2): on by default; undefined while the group feature is off. */
export function useMapGroups(rootLineId: string, onAction: SelectionHandler): MapGroupsProps | undefined {
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "group");
  const [shown, setShown] = useState(true);
  const groups = useGroups(rootLineId, on);
  const actions = useSelectionActions(rootLineId, onAction);
  if (!on) return undefined;
  return { on: shown, onToggle: setShown, groups: groups.data?.groups ?? NO_GROUPS, ...(actions ? { selection: actions.render } : {}) };
}
