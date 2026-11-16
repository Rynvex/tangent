/**
 * F17 S4/S5: 「包含的問答輪次（共 N 輪）」 in the node inspector. Every round
 * is a card: its #n, its time, 「提問：」 in full and 「回覆：」 in three lines
 * (two on a phone) with 展開完整回覆. Once analyzed, a round can move:
 * 「移至其他節點」 opens a menu (a bottom sheet 「把第 #n 輪移到…」 on a phone)
 * of every node, 拆成新支線 and 拆成獨立對話; on a desktop its grip also
 * drags it onto a node of the canvas (Enter or Space on the grip opens the
 * same menu). Long nodes show their rounds a page at a time.
 */
import { extractSessionRounds, NEW_BRANCH, NEW_STANDALONE, type SessionRound, type TimelineSession } from "@tangent/client";
import { BottomSheet, Popover, PopoverContent, PopoverTrigger } from "@tangent/react";
import { Bookmark, ChevronDown, CornerDownRight, ExternalLink, GitBranch, GripVertical } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cx } from "../cx";
import type { AiTreeView } from "./use-ai-tree";
import { useF17T } from "./f17-messages";
import type { MindMapModelNode } from "./mindmap-model";
import { clockOf } from "./time-format";
import type { MindMap } from "./use-mindmap";

/** Rounds shown at first, and added by 再顯示. */
const PAGE = 40;
/** Answers longer than this get 展開完整回覆. */
const LONG_ANSWER = 60;
/** Titles in the move menu stay short. */
const MENU_TITLE = 26;

const short = (text: string) => (Array.from(text).length <= MENU_TITLE ? text : `${Array.from(text).slice(0, MENU_TITLE - 1).join("")}…`);
const clock = (iso: string | null) => (iso ? clockOf(Date.parse(iso)) : "");

/** One card of the list: an analyzed unit (#n, movable) or a round of a whole session. */
export interface TurnItem {
  key: string;
  /** The analysis' unit it is (movable), or null. */
  unit: string | null;
  label: string;
  turn: number | null;
  time: string | null;
  rounds: SessionRound[];
}

/** The node's cards: its units once analyzed, else its own session's rounds. */
export function turnItems(node: MindMapModelNode, sessionOf: (key: string) => TimelineSession | undefined, removedOf: (key: string) => ReadonlySet<string>): TurnItem[] {
  if (node.units.length > 0) {
    return node.units.flatMap((unit, index) => {
      const session = sessionOf(unit);
      if (!session) return [];
      const rounds = extractSessionRounds(session, removedOf(unit));
      return [{ key: unit, unit, label: `#${node.turns[index]}`, turn: node.turns[index] ?? null, time: rounds[0]?.time ?? null, rounds }];
    });
  }
  const session = sessionOf(node.key);
  if (!session) return [];
  return extractSessionRounds(session, removedOf(node.key)).map((round) => ({ key: `${node.key}:${round.n}`, unit: null, label: `#${round.n}`, turn: null, time: round.time, rounds: [round] }));
}

function RoundText({ round, touch }: { round: SessionRound; touch: boolean }) {
  const t = useF17T();
  const [open, setOpen] = useState(false);
  const long = Array.from(round.answer).length > LONG_ANSWER || round.answer.includes("\n");
  return (
    <>
      <p className={cx("m-0 text-tg-sm leading-relaxed break-words text-tg-foreground-strong", touch ? "pl-2" : "pl-6.5")}>
        <b className="font-semibold text-tg-muted">{t("ins.question")}</b>
        {round.question}
      </p>
      {round.answer && (
        <p className={cx("m-0 text-tg-sm leading-relaxed break-words whitespace-pre-line text-tg-foreground", touch ? "pl-2" : "pl-6.5", !open && (touch ? "line-clamp-2" : "line-clamp-3"))}>
          <b className="font-semibold text-tg-muted">{t("ins.answer")}</b>
          {round.answer}
        </p>
      )}
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className={cx("inline-flex w-fit items-center gap-1 rounded-tg-sm px-1 text-tg-xs text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "ml-1 min-h-11" : "ml-5.5 min-h-5")}
        >
          {open ? t("ins.collapse") : t("ins.expand")}
          <ChevronDown aria-hidden className={cx("size-3", open && "rotate-180")} />
        </button>
      )}
    </>
  );
}

interface MoveOption {
  target: string;
  label: string;
  icon: ReactNode;
  current: boolean;
  separate?: boolean;
}

function moveOptions(map: MindMap, node: MindMapModelNode, t: ReturnType<typeof useF17T>): MoveOption[] {
  const icon = (role: string) =>
    role === "chapter" ? <Bookmark aria-hidden className="size-4 text-tg-primary-text" /> : role === "standalone" ? <ExternalLink aria-hidden className="size-4 text-tg-muted" /> : <CornerDownRight aria-hidden className="size-4 text-tg-branch-merged" />;
  const nodes = map.model.nodes.map((item): MoveOption => {
    const label = item.role === "chapter" ? `§${item.chapter ?? ""} ${short(item.title)}` : item.role === "standalone" ? `${t("ins.role.solo")}：${short(item.title)}` : `↳ ${short(item.title)}`;
    return { target: item.key, label, icon: icon(item.role), current: item.key === node.key };
  });
  return [
    ...nodes,
    { target: NEW_BRANCH, label: t("move.newBranchPlain"), icon: <GitBranch aria-hidden className="size-4 text-tg-muted" />, current: false, separate: true },
    { target: NEW_STANDALONE, label: t("move.newSolo"), icon: <ExternalLink aria-hidden className="size-4 text-tg-muted" />, current: false },
  ];
}

function MoveList({ options, touch, onPick }: { options: readonly MoveOption[]; touch: boolean; onPick: (target: string) => void }) {
  const t = useF17T();
  return (
    <div role="menu" className="flex flex-col p-1">
      {options.map((option) => (
        <div key={option.target} className="flex flex-col">
          {option.separate && <span aria-hidden className="mx-2 my-1 h-px bg-tg-border" />}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={option.current}
            data-tg-move-target={option.target}
            onClick={() => !option.current && onPick(option.target)}
            className={cx("flex min-h-11 w-full items-center gap-2.5 rounded-tg-sm px-2.5 text-left text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", option.current && "bg-tg-accent", !touch && "min-h-9")}
          >
            {option.icon}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.current && <span className="text-tg-xs text-tg-muted">{t("move.current")}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}

/** 移至其他節點 for one analyzed round: a popover on a desktop, a bottom sheet on a phone. */
function MoveMenu({ item, node, map, view, touch, onMoved }: { item: TurnItem; node: MindMapModelNode; map: MindMap; view: AiTreeView; touch: boolean; onMoved: () => void }) {
  const t = useF17T();
  const [open, setOpen] = useState(false);
  const turn = item.label;
  const pick = (target: string) => {
    setOpen(false);
    view.moveUnit(item.unit!, target);
    onMoved();
  };
  const options = moveOptions(map, node, t);
  const trigger = cx("inline-flex shrink-0 items-center gap-1 rounded-tg-sm border border-tg-border-input bg-tg-surface px-2 text-[0.6875rem] whitespace-nowrap hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring aria-expanded:bg-tg-accent", touch ? "min-h-11" : "min-h-6");
  const content = (
    <>
      {t("ins.moveTurn")}
      <ChevronDown aria-hidden className="size-3 text-tg-muted" />
    </>
  );
  if (touch) {
    return (
      <>
        <button type="button" data-tg-inspector-move-unit={item.unit} aria-haspopup="dialog" aria-expanded={open} aria-label={t("ins.moveTurnLabel", { turn })} onClick={() => setOpen(true)} className={trigger}>
          {content}
        </button>
        <BottomSheet open={open} onOpenChange={setOpen} label={t("move.title", { turn })}>
          <p className="m-0 px-2 pb-1.5 font-semibold text-tg-foreground-strong">{t("move.title", { turn })}</p>
          <MoveList options={options} touch onPick={pick} />
        </BottomSheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger data-tg-inspector-move-unit={item.unit ?? ""} data-tg-move-trigger={item.unit ?? ""} aria-label={t("ins.moveTurnLabel", { turn })} className={trigger}>
        {content}
      </PopoverTrigger>
      <PopoverContent aria-label={t("move.title", { turn })} side="bottom" align="end" className="w-72 px-0 py-0">
        <MoveList options={options} touch={false} onPick={pick} />
      </PopoverContent>
    </Popover>
  );
}

function Grip({ item, map }: { item: TurnItem; map: MindMap }) {
  const t = useF17T();
  return (
    <button
      type="button"
      draggable
      aria-label={t("ins.drag", { turn: item.label })}
      onDragStart={(event) => {
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", item.label);
        }
        map.startTurnDrag({ unit: item.unit!, turn: item.turn ?? 0 });
      }}
      onDragEnd={map.endTurnDrag}
      onKeyDown={(event) => {
        // The keyboard's way to move it: the card's menu.
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.closest("[data-tg-inspector-round]")?.querySelector<HTMLElement>("[data-tg-move-trigger]")?.click();
      }}
      className="grid h-6.5 w-5.5 shrink-0 cursor-grab place-items-center rounded-tg-sm text-tg-subtle hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-tg-ring"
    >
      <GripVertical aria-hidden className="size-3.5" />
    </button>
  );
}

export interface TurnListProps {
  node: MindMapModelNode;
  items: readonly TurnItem[];
  map: MindMap;
  view: AiTreeView | null;
  touch: boolean;
  /** After a move (the card left this node): where focus goes. */
  onMoved: () => void;
}

export function TurnList({ node, items, map, view, touch, onMoved }: TurnListProps) {
  const t = useF17T();
  const [shown, setShown] = useState(PAGE);
  const headingId = useId();
  const movable = view !== null && node.units.length > 0;
  const total = items.reduce((sum, item) => sum + item.rounds.length, 0);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="m-0 flex items-center gap-1.5 text-tg-sm font-semibold text-tg-foreground-strong">
        {t("ins.turns")}
        <span className="font-tg-mono text-tg-xs font-normal text-tg-muted">{t("ins.turnCount", { n: total })}</span>
      </h4>
      {!movable && <p className="m-0 text-tg-xs text-tg-muted">{t("ins.noMove")}</p>}
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {items.slice(0, shown).map((item) => {
          const dragging = map.turnDrag?.unit === item.unit && item.unit !== null;
          return (
            <li key={item.key} data-tg-inspector-round={item.key} className={cx("flex flex-col gap-1.5 rounded-tg border py-2 pr-2.5 pl-1", dragging ? "border-dashed border-tg-primary bg-tg-primary-soft" : "border-tg-border bg-tg-surface")}>
              <span className="flex items-center gap-1.5">
                {movable && !touch ? <Grip item={item} map={map} /> : <span aria-hidden className="w-1" />}
                <span className="inline-flex h-5 items-center rounded-[5px] bg-tg-surface-sunken px-1.5 font-tg-mono text-[0.6875rem] font-semibold">{item.label}</span>
                <span className="font-tg-mono text-[0.6875rem] text-tg-muted">{clock(item.time)}</span>
                <span className="flex-1" />
                {movable && <MoveMenu item={item} node={node} map={map} view={view} touch={touch} onMoved={onMoved} />}
              </span>
              {dragging ? (
                <p className="m-0 pl-7 text-tg-xs text-tg-muted">{t("ins.dragging", { turn: item.label })}</p>
              ) : (
                item.rounds.map((round) => <RoundText key={round.n} round={round} touch={touch} />)
              )}
            </li>
          );
        })}
      </ol>
      {items.length > shown && (
        <button type="button" onClick={() => setShown((count) => count + PAGE)} className={cx("self-start rounded-tg-sm px-1.5 text-tg-xs font-medium text-tg-primary-text hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-tg-ring", touch ? "min-h-11" : "min-h-7")}>
          {t("ins.more", { n: Math.min(PAGE, items.length - shown) })}
        </button>
      )}
    </section>
  );
}
