import { MAP_ROOT_KEY, branchPath, isFeatureOn, mapFisheyeLevels } from "@tangent/client";
import { useMemo, useState } from "react";
import { useGroups } from "../data/group-hooks";
import { useBranches, useCapabilities, usePreview } from "../data/queries";
import type { MapFisheyeProps } from "../structure/map-layers";

/**
 * The branch map's 魚眼 layer fed from the server (C1): off until switched
 * on (it costs a `POST /preview` of the line on screen, the same query the
 * send preview uses for an empty draft), then each node's level. Undefined
 * while the fisheye feature is off.
 */
export function useMapFisheye(rootLineId: string, currentLineId: string): MapFisheyeProps | undefined {
  const capabilities = useCapabilities();
  const featureOn = isFeatureOn(capabilities.data, "fisheye");
  const [on, setOn] = useState(false);
  const preview = usePreview(currentLineId, "", featureOn && on);
  const outline = useBranches(rootLineId, true);
  const report = preview.data?.fisheye;
  const groups = useGroups(rootLineId, featureOn && on && (report?.items.some((item) => item.kind === "group") ?? false));
  const groupList = groups.data?.groups;
  const branches = outline.data?.branches;
  const levels = useMemo(() => {
    if (!report || !branches) return null;
    const ancestors = [rootLineId, ...branchPath(currentLineId, branches).map((branch) => branch.parentLineId)];
    return mapFisheyeLevels(report, { rootLineId, currentLineId, ancestors, nodeKeys: [MAP_ROOT_KEY, ...branches.map((branch) => branch.lineId)], ...(groupList ? { groups: groupList } : {}) });
  }, [report, branches, rootLineId, currentLineId, groupList]);
  return featureOn ? { on, onToggle: setOn, levels } : undefined;
}
