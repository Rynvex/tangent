/**
 * The map's layer switches (handoff §9-7: structure and status always show;
 * argument types, groups, relations and fisheye are layers, each its own visual
 * channel) and the fisheye legend.
 */
import type { FisheyeLevel } from "@tangent/client";
import { Eye, Group as GroupIcon, Link2, NotebookPen, Tag } from "lucide-react";
import type { ReactNode } from "react";
import { useP2T } from "../i18n/p2-messages";
import { cx } from "../lib/cx";
import { FISHEYE_OPACITY, FISHEYE_ORDER, LEVEL_KEYS } from "../p2/fisheye-levels";

/** The 魚眼 layer as the host gives it: whether it is on, the switch, and each node's level (null while loading). */
export interface MapFisheyeProps {
  on: boolean;
  onToggle: (on: boolean) => void;
  levels: ReadonlyMap<string, FisheyeLevel> | null;
}

export interface MapLayer {
  id: "groups" | "relations" | "fisheye" | "tags" | "notes";
  on: boolean;
  onChange: (on: boolean) => void;
  /** The switch's name when the layer's wording lives elsewhere (focus mode's 筆記). */
  label?: string;
}

const ICONS: Record<MapLayer["id"], ReactNode> = {
  tags: <Tag aria-hidden className="size-3" />,
  groups: <GroupIcon aria-hidden className="size-3" />,
  relations: <Link2 aria-hidden className="size-3" />,
  fisheye: <Eye aria-hidden className="size-3" />,
  notes: <NotebookPen aria-hidden className="size-3" />,
};

export function LayerSwitch({ layers }: { layers: readonly MapLayer[] }) {
  const t = useP2T();
  const labels: Partial<Record<MapLayer["id"], string>> = { tags: t("tag.layer"), groups: t("group.layer"), relations: t("relation.layer"), fisheye: t("fisheye.layer") };
  return (
    <div role="group" aria-label={t("relation.layers")} className="flex flex-wrap items-center gap-1.5 px-0.5">
      {layers.map((layer) => (
        <button
          key={layer.id}
          type="button"
          aria-pressed={layer.on}
          onClick={() => layer.onChange(!layer.on)}
          className={cx(
            "inline-flex h-6.5 items-center gap-1 rounded-tg-full border px-2.5 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11",
            layer.on ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-strong text-tg-muted hover:text-tg-foreground",
          )}
        >
          {ICONS[layer.id]}
          {layer.label ?? labels[layer.id]}
        </button>
      ))}
    </div>
  );
}

/** What each opacity means (C1 legend): a swatch per level, faded as the nodes are. */
export function FisheyeLegend() {
  const t = useP2T();
  return (
    <ul aria-label={t("fisheye.legend")} className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 px-1 py-0 text-[0.6875rem] text-tg-muted">
      {FISHEYE_ORDER.map((level: FisheyeLevel) => (
        <li key={level} className="inline-flex items-center gap-1">
          <span aria-hidden className={cx("size-2.5 rounded-tg-sm border border-tg-border-strong bg-tg-primary", FISHEYE_OPACITY[level])} />
          {t(LEVEL_KEYS[level])}
        </li>
      ))}
    </ul>
  );
}

/** The 論證類型 layer as the host gives it (the ibis feature, D2): whether it is on, and the switch. */
export interface MapTagsProps {
  on: boolean;
  onToggle: (on: boolean) => void;
}
