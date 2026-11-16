import { isFeatureOn } from "@tangent/client";
import { useState } from "react";
import { useCapabilities } from "../data/queries";
import type { MapTagsProps } from "../structure/map-layers";

/** The branch map's 論證類型 layer (D2): off until switched on; undefined while the ibis feature is off. */
export function useMapTags(): MapTagsProps | undefined {
  const capabilities = useCapabilities();
  const [on, setOn] = useState(false);
  return isFeatureOn(capabilities.data, "ibis") ? { on, onToggle: setOn } : undefined;
}
