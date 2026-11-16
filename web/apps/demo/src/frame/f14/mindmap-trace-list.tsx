/**
 * F17 S3 on a phone (decision #7): the canvas is too small for six crossing
 * curves, so with 顯示穿插順序 on the panel under it lists 「原對話的穿插順序」
 * instead: every round of the interleaved stretch with its time and the node
 * it was put in; a row selects that node on the canvas.
 */
import { sessionTimes } from "@tangent/client";
import { Bookmark, CornerDownRight, ExternalLink, Route } from "lucide-react";
import { useId } from "react";
import { cx } from "../cx";
import { useF17T } from "./f17-messages";
import { clockOf } from "./time-format";
import type { Assembly } from "./use-assembly";
import type { MindMap } from "./use-mindmap";

export function TraceList({ map, assembly }: { map: MindMap; assembly: Assembly }) {
  const t = useF17T();
  const titleId = useId();
  const range = map.layout.trace.range;
  if (!range) return null;
  const turns = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => range[0] + i);
  return (
    <section data-tg-mindmap-trace-list="" aria-labelledby={titleId} className="flex flex-col gap-1 px-4 py-2.5">
      <h3 id={titleId} className="m-0 flex items-center gap-1.5 text-tg-sm font-semibold text-tg-foreground-strong">
        <Route aria-hidden className="size-3.5 text-tg-warning" />
        {t("ins.traceTitle")}
      </h3>
      <ol className="m-0 flex list-none flex-col p-0">
        {turns.map((turn) => {
          const home = map.model.turnHome.get(turn);
          const node = home ? map.model.byKey.get(home) : undefined;
          if (!node) return null;
          const unit = node.units[node.turns.indexOf(turn)];
          const session = unit ? assembly.orderedOriginal.find((item) => item.key === unit) : undefined;
          const start = session ? sessionTimes(session).start : null;
          const where = node.role === "chapter" ? `§${node.chapter ?? ""} ${node.title}` : node.role === "standalone" ? node.title : `↳ ${node.title}`;
          const icon = node.role === "chapter" ? <Bookmark aria-hidden className="size-3 shrink-0 text-tg-primary-text" /> : node.role === "standalone" ? <ExternalLink aria-hidden className="size-3 shrink-0 text-tg-muted" /> : <CornerDownRight aria-hidden className="size-3 shrink-0 text-tg-branch-merged" />;
          return (
            <li key={turn}>
              <button
                type="button"
                data-tg-trace-row={turn}
                aria-current={map.selected === node.key || undefined}
                onClick={() => map.select(node.key)}
                className={cx("grid min-h-11 w-full grid-cols-[2rem_2.75rem_minmax(0,1fr)] items-center gap-1.5 rounded-tg-sm px-1 text-left text-tg-xs hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", map.selected === node.key && "bg-tg-accent")}
              >
                <b className="font-tg-mono font-semibold">#{turn}</b>
                <span className="font-tg-mono text-tg-muted">{start !== null ? clockOf(start) : "—"}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  {icon}
                  <span className="truncate">{where}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
