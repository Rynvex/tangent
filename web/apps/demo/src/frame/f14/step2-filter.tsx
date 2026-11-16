/**
 * F16.1: S2's filter row (from 5 sessions): a search over titles and first
 * prompts (matchSession), role chips (全部, § 章節, ↳ 支線, 獨立對話; left
 * and right arrows move between them) and 「全選目前顯示（n）」.
 */
import { matchSession, type BlueprintNode, type NodeRole, type TimelineSession } from "@tangent/client";
import { Search } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";

export type RoleFilter = "all" | "chapter" | "branch" | "standalone";

export interface Step2Filter {
  query: string;
  role: RoleFilter;
}

export const NO_FILTER: Step2Filter = { query: "", role: "all" };

/** Whether a node's role is the chip's. */
const roleMatches = (filter: RoleFilter, role: NodeRole | undefined) =>
  filter === "all" || (filter === "branch" ? role === "merged_branch" || role === "open_branch" : role === filter);

/** The sessions the filter shows, in order. */
export function filterSessions(sessions: readonly TimelineSession[], nodes: readonly BlueprintNode[], filter: Step2Filter): TimelineSession[] {
  const roles = new Map(nodes.map((node) => [node.key, node.role]));
  return sessions.filter((session) => roleMatches(filter.role, roles.get(session.key)) && matchSession(session.conversation, filter.query) !== null);
}

const CHIPS: readonly RoleFilter[] = ["all", "chapter", "branch", "standalone"];
const STEP: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowLeft: -1 };

export interface Step2FilterBarProps {
  filter: Step2Filter;
  onFilter: (next: Step2Filter) => void;
  shown: number;
  /** How many of the shown ones are checked. */
  checkedShown: number;
  touch: boolean;
  onSelectShown: (on: boolean) => void;
}

function SelectShown({ shown, checkedShown, touch, onSelectShown }: Pick<Step2FilterBarProps, "shown" | "checkedShown" | "touch" | "onSelectShown">) {
  const t = useF14T();
  const box = useRef<HTMLInputElement>(null);
  const all = shown > 0 && checkedShown === shown;
  useEffect(() => {
    if (box.current) box.current.indeterminate = checkedShown > 0 && !all;
  }, [checkedShown, all]);
  return (
    <label className={cx("inline-flex items-center gap-1.5 text-tg-xs text-tg-foreground", touch ? "min-h-11" : "min-h-7")}>
      <input ref={box} type="checkbox" data-tg-select-shown="" checked={all} disabled={shown === 0} onChange={() => onSelectShown(!all)} className={cx("accent-tg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring", touch ? "size-5.5" : "size-4")} />
      {t("f161.selectShown", { n: shown })}
    </label>
  );
}

export function Step2FilterBar({ filter, onFilter, shown, checkedShown, touch, onSelectShown }: Step2FilterBarProps) {
  const t = useF14T();
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = CHIPS[(CHIPS.indexOf(filter.role) + step + CHIPS.length) % CHIPS.length]!;
    onFilter({ ...filter, role: next });
    group.current?.querySelector<HTMLElement>(`[data-tg-role-filter="${next}"]`)?.focus();
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label className={cx("flex items-center gap-1.5 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 focus-within:outline-2 focus-within:outline-tg-ring", touch ? "h-11" : "h-8")}>
        <Search aria-hidden className="size-3.5 text-tg-muted" />
        <input
          type="search"
          data-tg-step2-search=""
          aria-label={t("f161.search")}
          placeholder={t("f161.searchPlaceholder")}
          value={filter.query}
          onChange={(event) => onFilter({ ...filter, query: event.target.value })}
          className="min-w-0 flex-1 bg-transparent text-tg-sm text-tg-foreground outline-none placeholder:text-tg-muted"
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <div ref={group} role="radiogroup" aria-label={t("f161.roleFilter")} onKeyDown={onKeyDown} className="flex flex-wrap gap-1">
          {CHIPS.map((chip) => {
            const on = filter.role === chip;
            return (
              <button
                key={chip}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                data-tg-role-filter={chip}
                onClick={() => onFilter({ ...filter, role: chip })}
                className={cx(
                  "rounded-tg-full border px-2 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring",
                  touch ? "min-h-11" : "h-6",
                  on ? "border-tg-primary bg-tg-primary-soft font-medium text-tg-primary-text" : "border-tg-border bg-tg-surface text-tg-foreground hover:border-tg-border-strong",
                )}
              >
                {t(`f161.filter.${chip}`)}
              </button>
            );
          })}
        </div>
        <span className="ml-auto">
          <SelectShown shown={shown} checkedShown={checkedShown} touch={touch} onSelectShown={onSelectShown} />
        </span>
      </div>
    </div>
  );
}
