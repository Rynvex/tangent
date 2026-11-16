/**
 * The map's 群組 layer (C2; handoff §9-7: the frame is the group's channel):
 * a frame around each group's members, an XMind summary bracket on its right
 * and the shared summary in a box beside the tree.
 */
import { Working } from "../components/working";
import type { BranchView, Group, GroupFrame } from "@tangent/client";
import type { ReactNode } from "react";
import { useP2T } from "../i18n/p2-messages";

/** The 群組 layer as the host gives it (the group feature on). */
export interface MapGroupsProps {
  on: boolean;
  onToggle: (on: boolean) => void;
  /** The tree's active groups. */
  groups: readonly Group[];
  /**
   * Multi-select for a writer (absent for a viewer): renders the selection's
   * action under the map; `done` ends the selection.
   */
  selection?: (selected: readonly BranchView[], done: () => void) => ReactNode;
}

/** Frames, brackets and connectors, under the nodes. */
export function GroupFrameLines({ frames, width, height }: { frames: readonly GroupFrame[]; width: number; height: number }) {
  return (
    <svg aria-hidden width={width} height={height} className="absolute inset-0 overflow-visible">
      {frames.map((frame) => (
        <g key={frame.groupId}>
          <rect data-tg-group-frame={frame.groupId} x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={10} strokeWidth={1.5} className="fill-tg-surface stroke-tg-muted" />
          <path data-tg-group-bracket={frame.groupId} d={frame.bracket} fill="none" strokeWidth={1.25} className="stroke-tg-muted" />
          <path d={frame.connector} fill="none" strokeWidth={1} className="stroke-tg-border-strong" />
        </g>
      ))}
    </svg>
  );
}

function SummaryText({ group }: { group: Group }) {
  const t = useP2T();
  if (group.summaryStatus === "drafting") return <Working>{t("group.drafting")}</Working>;
  return (
    <>
      {group.summaryStatus === "failed" && <span className="text-tg-warning">{t("group.failedSummary")}</span>}
      {group.summary ? <span className="text-tg-foreground">{group.summary}</span> : group.summaryStatus !== "failed" && <span className="text-tg-muted">{t("group.noSummary")}</span>}
    </>
  );
}

/** Each group's name and shared summary, right of the tree (above the lines, readable at full contrast). */
export function GroupSummaries({ frames }: { frames: readonly GroupFrame[] }) {
  const t = useP2T();
  return (
    <>
      {frames.map((frame) => (
        <article
          key={frame.groupId}
          aria-label={t("group.frame", { title: frame.group.title })}
          className="absolute flex flex-col gap-0.5 overflow-hidden rounded-tg-sm border border-tg-border-strong bg-tg-surface-raised px-2 py-1.5 text-[0.6875rem] leading-snug shadow-tg"
          style={{ left: frame.box.x, top: frame.box.y, width: frame.box.width, maxHeight: frame.box.height }}
        >
          <span className="truncate font-semibold text-tg-foreground">{t("group.frame", { title: frame.group.title })}</span>
          <span className="line-clamp-3 flex flex-col break-words">
            <SummaryText group={frame.group} />
          </span>
          {frame.hidden > 0 && <span className="text-tg-muted">{t("group.hiddenMembers", { count: frame.hidden })}</span>}
        </article>
      ))}
    </>
  );
}
