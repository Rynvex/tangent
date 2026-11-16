import type { FisheyeLevel } from "@tangent/client";
import type { P2MessageKey } from "../i18n/p2-messages";

/** 完整 / 摘要 / 只有一句收尾 / 看不到. */
export const LEVEL_KEYS: Record<FisheyeLevel, P2MessageKey> = {
  full: "fisheye.level.full",
  summary: "fisheye.level.summary",
  leaf_only: "fisheye.level.leaf_only",
  hidden: "fisheye.level.hidden",
};

/** The map's fisheye channel (handoff §9-7: opacity = fisheye), applied to a node's frame, never to its words. */
export const FISHEYE_OPACITY: Record<FisheyeLevel, string> = {
  full: "opacity-100",
  summary: "opacity-75",
  leaf_only: "opacity-55",
  hidden: "opacity-30",
};

export const FISHEYE_ORDER: readonly FisheyeLevel[] = ["full", "summary", "leaf_only", "hidden"];
