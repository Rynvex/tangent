/**
 * F14 AssemblyModePicker: three single-choice cards (時間軸章節圖
 * GitCommitVertical, 主幹＋支線樹 GitFork, 批次獨立匯入 Layers); the tree
 * is marked 建議 when sessions overlap or are over 2,000 messages together,
 * never chosen by itself (decision #2). Left and right arrows move the
 * choice. With relations off, batch still works and says it links nothing.
 */
import type { AssemblyMode } from "@tangent/client";
import { GitCommitVertical, GitFork, Layers, Sparkles } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";

export interface ModePickerProps {
  mode: AssemblyMode;
  recommendTree: boolean;
  relations: boolean;
  touch: boolean;
  onMode: (mode: AssemblyMode) => void;
}

const MODES: readonly AssemblyMode[] = ["timeline", "tree", "batch"];
const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function ModePicker({ mode, recommendTree, relations, touch, onMode }: ModePickerProps) {
  const t = useF14T();
  const group = useRef<HTMLDivElement>(null);
  const cards: Record<AssemblyMode, { icon: ReactNode; title: string; sub: string }> = {
    timeline: { icon: <GitCommitVertical aria-hidden className="size-4" />, title: t("assembly.timeline"), sub: t("assembly.timelineSub") },
    tree: { icon: <GitFork aria-hidden className="size-4" />, title: t("assembly.tree"), sub: t("assembly.treeSub") },
    batch: { icon: <Layers aria-hidden className="size-4" />, title: t("assembly.batch"), sub: relations ? t("assembly.batchSub") : t("assembly.batchSubNoRelations") },
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = MODES[(MODES.indexOf(mode) + step + MODES.length) % MODES.length]!;
    onMode(next);
    group.current?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
  };
  return (
    <div ref={group} role="radiogroup" aria-label={t("assembly.modeLabel")} onKeyDown={onKeyDown} className={cx("grid gap-1.5", touch ? "grid-cols-1" : "grid-cols-3")}>
      {MODES.map((value) => {
        const on = value === mode;
        const card = cards[value];
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-mode={value}
            onClick={() => onMode(value)}
            className={cx(
              "relative flex rounded-tg border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
              touch ? "h-13 flex-row items-center gap-2.5" : "h-16 flex-col items-start justify-center gap-1",
              on ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border bg-tg-surface text-tg-foreground-strong hover:border-tg-border-strong",
            )}
          >
            <span className={on ? "text-tg-primary-text" : "text-tg-muted"}>{card.icon}</span>
            <span className="flex min-w-0 flex-col">
              <span className="text-tg-sm font-semibold">{card.title}</span>
              <span className="truncate text-tg-xs font-normal text-tg-muted">{card.sub}</span>
            </span>
            {value === "tree" && recommendTree && (
              <span className="absolute -top-2 right-2 inline-flex items-center gap-0.5 rounded-tg-full border border-tg-warning bg-tg-warning-soft px-1.5 text-[0.6875rem] font-medium text-tg-foreground">
                <Sparkles aria-hidden className="size-3" />
                {t("assembly.recommended")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
