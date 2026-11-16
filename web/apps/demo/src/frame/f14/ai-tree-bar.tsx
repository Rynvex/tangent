/**
 * F16.2 AiTreeBar, at the top of step 2: 「✨ AI 智慧分析並畫出支線樹」 with
 * its hint, 「拆解對話內部的穿插問答輪次」 for 1–3 conversations of 6
 * messages or more (on by default; off and explained past 200 rounds), the
 * wait, the result (how many chapters, branches and separate conversations,
 * and honestly who made it: the model or the built-in rules), a failure with
 * 再試一次, and 還原分析前狀態.
 * F17: the view switch (心智圖工作區｜雙欄時間序清單) and the full-width
 * button on the first row; analyzing again after the tree was adjusted by
 * hand asks first (decision #8): 「重新分析會取代目前的調整，確定重新分析？」.
 */
import { IMPORT_ANALYZE_MAX_UNITS, isBranchRole, type AssemblyBlueprint } from "@tangent/client";
import { Button } from "@tangent/react";
import { LoaderCircle, Network, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cx } from "../cx";
import { focusIfLost } from "./ai-node-panel";
import { canExpand } from "./ai-tree-plan";
import { useF162T } from "./f162-messages";
import { useF17T } from "./f17-messages";
import type { AiTree } from "./use-ai-tree";
import { ViewSwitch, type ViewSwitchProps } from "./view-switch";

export interface AiTreeBarProps {
  tree: AiTree;
  blueprint: AssemblyBlueprint;
  /** How many original sessions each visible node holds (threaded topics have 2 or more). */
  mergedCountOf: (key: string) => number;
  touch: boolean;
  /** F17: the view switch and the full-width button. */
  views: Omit<ViewSwitchProps, "touch">;
}

/** The result line's numbers, from the tree as it is now (fine-tuning changes them). */
function counts(blueprint: AssemblyBlueprint, mergedCountOf: (key: string) => number) {
  const { nodes } = blueprint;
  return {
    c: nodes.filter((node) => node.role === "chapter").length,
    b: nodes.filter((node) => isBranchRole(node.role)).length,
    s: nodes.filter((node) => node.role === "standalone").length,
    t: nodes.filter((node) => mergedCountOf(node.key) > 1).length,
  };
}

/** Decision #8: 「確定重新分析」 or 取消, before an analysis replaces what the user adjusted. */
function ConfirmAgain({ onConfirm, onCancel, touch }: { onConfirm: () => void; onCancel: () => void; touch: boolean }) {
  const t = useF17T();
  const textId = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <div role="group" aria-labelledby={textId} data-tg-ai-confirm="" className="flex flex-wrap items-center gap-2 rounded-tg-sm border border-tg-warning bg-tg-warning-soft px-2 py-1.5 text-tg-xs text-tg-foreground">
      <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-tg-warning" />
      <span id={textId} className="min-w-0 flex-1">
        {t("ai.confirmText")}
      </span>
      <Button ref={confirm} size="sm" variant="primary" data-tg-ai-confirm-reanalyze="" onClick={onConfirm} className={cx(touch && "h-11")}>
        {t("ai.confirm")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} className={cx(touch && "h-11")}>
        {t("ai.cancel")}
      </Button>
    </div>
  );
}

export function AiTreeBar({ tree, blueprint, mergedCountOf, touch, views }: AiTreeBarProps) {
  const t = useF162T();
  const f17 = useF17T();
  const hintId = useId();
  const [confirming, setConfirming] = useState(false);
  const busy = tree.request.kind === "busy";
  const analyze = () => {
    if (busy) return;
    if (tree.analyzed && tree.adjusted) return setConfirming(true);
    tree.analyze();
  };
  const expandable = canExpand(tree.rounds);
  // Phones keep the bar short: the hints are read out but not shown, and after an analysis the button shrinks.
  const compact = touch && tree.analyzed;
  // F17: beside the mind map the bar keeps to its first row and one result line; the hints are read out only.
  const slim = !touch && views.view === "mindmap";
  return (
    <section data-tg-ai-tree-bar="" aria-label={t("ai.bar")} aria-busy={busy || undefined} className={cx("flex flex-col gap-2 rounded-tg border border-tg-primary bg-tg-primary-soft px-3 py-2.5", touch ? "mx-4 mt-2" : "mx-5 mt-3")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          variant="primary"
          size={compact ? "sm" : "md"}
          data-tg-ai-analyze=""
          aria-disabled={busy || undefined}
          aria-describedby={hintId}
          onClick={analyze}
          className={cx(touch && !compact && "h-auto min-h-11 w-full whitespace-normal py-2", compact && "h-11")}
        >
          {tree.analyzed ? t("ai.analyzeAgain") : t("ai.analyze")}
        </Button>
        <p id={hintId} className={touch || slim ? "sr-only" : "m-0 min-w-0 flex-1 text-tg-xs text-tg-muted"}>
          {t("ai.analyzeSub")}
        </p>
        {tree.analyzed && (
          <Button
            variant="ghost"
            size="sm"
            data-tg-ai-reset=""
            icon={<Undo2 aria-hidden className="size-3.5" />}
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              tree.reset();
            }}
            className={cx(touch ? "ml-auto h-11" : "ml-auto")}
          >
            {t("ai.reset")}
          </Button>
        )}
        {!touch && (
          <div className={cx(!tree.analyzed && "ml-auto")}>
            <ViewSwitch {...views} touch={false} />
          </div>
        )}
      </div>
      {touch && <ViewSwitch {...views} touch />}
      {confirming && (
        <ConfirmAgain
          touch={touch}
          onCancel={() => {
            setConfirming(false);
            focusIfLost("[data-tg-ai-analyze]");
          }}
          onConfirm={() => {
            setConfirming(false);
            focusIfLost("[data-tg-ai-analyze]");
            tree.analyze();
          }}
        />
      )}
      {tree.eligible && !compact && (
        <label className={cx("flex items-start gap-2 text-tg-xs", touch && "min-h-11 items-center")}>
          <input
            type="checkbox"
            data-tg-ai-expand=""
            checked={tree.expand && expandable}
            disabled={!expandable || busy}
            onChange={(event) => tree.setExpand(event.target.checked)}
            className={cx("mt-0.5 shrink-0 accent-tg-primary focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "size-5" : "size-4")}
          />
          <span className="min-w-0">
            <span className="font-medium text-tg-foreground">{t("ai.expand")}</span>
            <span className={touch || slim ? "sr-only" : "block text-tg-muted"}>{expandable ? t("ai.expandSub", { n: tree.rounds }) : t("ai.expandTooMany", { max: IMPORT_ANALYZE_MAX_UNITS })}</span>
          </span>
        </label>
      )}
      {/* Always present (an empty one takes no room), so what it says next is announced. */}
      <div role="status" className="flex flex-col gap-1 empty:-mt-2">
        {busy && (
          <p data-tg-ai-busy="" className="m-0 flex items-center gap-1.5 text-tg-xs text-tg-foreground">
            <LoaderCircle aria-hidden className="size-3.5 shrink-0 motion-safe:animate-spin text-tg-primary-text" />
            {t("ai.busy")}
          </p>
        )}
        {!busy && tree.analysis && (
          <div data-tg-ai-summary="" data-tg-ai-source={tree.analysis.plan.source} className={cx("flex gap-0.5 text-tg-xs", slim ? "flex-row flex-wrap gap-x-1.5" : "flex-col")}>
            {touch && (
              <p aria-hidden className="m-0 text-tg-foreground">
                {t("ai.doneShort", { ...counts(blueprint, mergedCountOf), source: t(tree.analysis.plan.source === "model" ? "ai.sourceShort.model" : "ai.sourceShort.heuristic") })}
              </p>
            )}
            <p className={touch ? "sr-only" : "m-0 text-tg-foreground"}>{t("ai.done", counts(blueprint, mergedCountOf))}</p>
            <p className={touch ? "sr-only" : "m-0 text-tg-muted"}>{tree.analysis.plan.source === "model" ? t("ai.source.model") : t("ai.source.heuristic")}</p>
          </div>
        )}
        {!busy && tree.analysis && !touch && views.view === "list" && (
          <button type="button" data-tg-ai-open-map="" onClick={() => views.onView("mindmap")} className="inline-flex w-fit items-center gap-1 rounded-tg-sm px-1 text-tg-xs font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring">
            <Network aria-hidden className="size-3.5" />
            {f17("view.summaryEnter")}
          </button>
        )}
      </div>
      {tree.request.kind === "failed" && (
        <div role="alert" data-tg-ai-error="" className="flex flex-wrap items-center gap-2 rounded-tg-sm border border-tg-destructive bg-tg-destructive-soft px-2 py-1.5 text-tg-xs text-tg-foreground">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-tg-destructive" />
          <span className="min-w-0 flex-1">{t("ai.failed", { reason: tree.request.reason })}</span>
          <Button size="sm" aria-disabled={busy || undefined} onClick={() => !busy && tree.analyze()} className={cx(touch && "h-11")}>
            {t("ai.retry")}
          </Button>
        </div>
      )}
    </section>
  );
}
