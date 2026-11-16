/**
 * F17 S1: step 2's two views. ViewSwitch (in the AiTreeBar): 心智圖工作區
 * (Network) ｜ 雙欄時間序清單 (List), left and right arrows moving the
 * choice, and the full-width button (Maximize2 / Minimize2) that folds the
 * inspector away (off in the list). Step 2 opens on the list, as before
 * F17; MindMapEntry, at the top of the list's structure column, says what
 * the mind map adds and opens it.
 */
import { List, Maximize2, Minimize2, Network } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { cx } from "../cx";
import { useF17T } from "./f17-messages";

export type StepView = "list" | "mindmap";

export interface ViewSwitchProps {
  view: StepView;
  onView: (view: StepView) => void;
  full: boolean;
  onFull: (full: boolean) => void;
  touch: boolean;
}

const VIEWS: readonly StepView[] = ["mindmap", "list"];

export function ViewSwitch({ view, onView, full, onFull, touch }: ViewSwitchProps) {
  const t = useF17T();
  const items: Record<StepView, { icon: ReactNode; label: string; data: Record<string, string> }> = {
    mindmap: { icon: <Network aria-hidden className="size-3.5" />, label: touch ? t("view.mindmapShort") : t("view.mindmap"), data: { "data-tg-view-mindmap": "" } },
    list: { icon: <List aria-hidden className="size-3.5" />, label: touch ? t("view.listShort") : t("view.list"), data: { "data-tg-view-list": "" } },
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = view === "list" ? "mindmap" : "list";
    const group = event.currentTarget;
    onView(next);
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus());
  };
  const fullLabel = full ? t("view.exitFull") : t("view.full");
  return (
    <div className={cx("flex items-center gap-2", touch ? "w-full" : "shrink-0")}>
      <div role="radiogroup" aria-label={t("view.label")} onKeyDown={onKeyDown} className={cx("flex gap-0.5 rounded-tg border border-tg-border-input bg-tg-surface p-0.5", touch && "grid flex-1 grid-cols-2")}>
        {VIEWS.map((value) => {
          const on = value === view;
          const item = items[value];
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-view={value}
              {...item.data}
              onClick={() => onView(value)}
              className={cx(
                "inline-flex items-center justify-center gap-1.5 rounded-tg-sm px-2.5 text-tg-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-tg-ring",
                touch ? "min-h-11" : "h-7",
                on ? "bg-tg-primary-soft font-medium text-tg-primary-text" : "text-tg-muted hover:bg-tg-accent hover:text-tg-foreground",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
      {!touch && (
        <button
          type="button"
          data-tg-mindmap-fullscreen=""
          aria-pressed={full}
          aria-label={fullLabel}
          title={fullLabel}
          disabled={view !== "mindmap"}
          onClick={() => onFull(!full)}
          className={cx(
            "grid size-8 shrink-0 place-items-center rounded-tg-sm border focus-visible:outline-2 focus-visible:outline-tg-ring disabled:opacity-45",
            full ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-input bg-tg-surface text-tg-muted hover:bg-tg-accent hover:text-tg-foreground",
          )}
        >
          {full ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
        </button>
      )}
    </div>
  );
}

/** At the top of the list's structure: what the mind map shows that the list cannot, and the way there. */
export function MindMapEntry({ onOpen, touch }: { onOpen: () => void; touch: boolean }) {
  const t = useF17T();
  return (
    <div data-tg-mindmap-entry="" className="flex flex-col gap-1 rounded-tg border border-dashed border-tg-primary bg-tg-surface px-2.5 py-2">
      <button type="button" onClick={onOpen} className={cx("inline-flex w-fit items-center gap-1.5 rounded-tg-sm px-1 text-left text-tg-sm font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch && "min-h-11")}>
        <Network aria-hidden className="size-4 shrink-0" />
        {t("view.enter")}
      </button>
      <p className="m-0 px-1 text-tg-xs text-tg-muted">{t("view.enterSub")}</p>
    </div>
  );
}
