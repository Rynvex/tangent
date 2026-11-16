/**
 * F16.2: 「✨ AI 智慧分析支線樹」 in step 2. `useAiSessions` holds the
 * analysis and gives the assembly its sessions (the expanded rounds, titled
 * by the plan, when the rounds were split); `useAiTree` asks the server
 * (`POST /lines/import-analyze`, waiting out 429s), applies the plan to the
 * assembly, keeps the arrangement from before the first analysis for 還原分析前
 * 狀態, and does the per-node fine-tuning (move one round, where a branch
 * hangs, one-click roles). The server falls back to its rules by itself, so
 * only the network or bad input fails a request; that leaves everything as
 * it was.
 */
import { analyzeExcerpts, applySessionMerges, IMPORT_ANALYZE_MAX_UNITS, withRateLimitRetry, type TangentClient, type TimelineSession } from "@tangent/client";
import { describeError, useTangent, useUiT } from "@tangent/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { analysisInput, applyAnalysis, canExpand, EXPAND_MAX_SESSIONS, EXPAND_MIN_MESSAGES, roundCount, type AiAnalysis } from "./ai-tree-plan";
import { useAiFineTune } from "./use-ai-fine-tune";
import { useF162T } from "./f162-messages";
import type { Assembly, AssemblyState } from "./use-assembly";

/** The sessions of an arrangement in its order (sessions it does not know join at the end). */
function inOrder(sessions: readonly TimelineSession[], order: readonly string[]): TimelineSession[] {
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const known = order.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []));
  return [...known, ...sessions.filter((session) => !order.includes(session.key))];
}

export function useAiSessions(picked: readonly TimelineSession[]) {
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [roundTimes, setRoundTimes] = useState<Readonly<Record<string, string | null>>>({});
  const sessions = useMemo(() => {
    const base = analysis?.unitSessions ?? picked;
    return base.map((session) => {
      const title = analysis?.titles[session.key];
      const manualTime = session.key in roundTimes ? roundTimes[session.key] : session.manualTime;
      return title || manualTime !== session.manualTime ? { ...session, manualTime, conversation: title ? { ...session.conversation, title } : session.conversation } : session;
    });
  }, [analysis, picked, roundTimes]);
  const ownsKey = (key: string) => analysis?.unitSessions?.some((session) => session.key === key) ?? false;
  return {
    analysis,
    setAnalysis,
    sessions,
    /** Sets a time on an expanded round (they are not the dialog's sessions); false when `key` is not one. */
    setRoundTime: (key: string, manualTime: string | null): boolean => {
      if (!ownsKey(key)) return false;
      setRoundTimes((current) => ({ ...current, [key]: manualTime }));
      return true;
    },
    clearRoundTimes: () => setRoundTimes({}),
  };
}

export type AiSessions = ReturnType<typeof useAiSessions>;

export interface UseAiTreeInput {
  ai: AiSessions;
  assembly: Assembly;
  /** The dialog's picked sessions (before any analysis). */
  picked: readonly TimelineSession[];
  client: TangentClient;
}

/** The analysis request's state: idle, asking, or failed with a reason. */
type Request = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; reason: string };

/** Whether the arrangement changed since `start` (an edit made while the analysis was asked). */
const changedSince = (start: AssemblyState, now: AssemblyState) => start.order !== now.order || start.edits !== now.edits || start.merges !== now.merges || start.mode !== now.mode;

export function useAiTree({ ai, assembly, picked, client }: UseAiTreeInput) {
  const t = useF162T();
  const ui = useUiT();
  const { hostErrorText } = useTangent();
  const [request, setRequest] = useState<Request>({ kind: "idle" });
  const [before, setBefore] = useState<AssemblyState | null>(null);
  // F17: the arrangement the last analysis drew; anything else means the user adjusted it (decision #8).
  const [drawn, setDrawn] = useState<AssemblyState | null>(null);
  const fineTune = useAiFineTune(ai, assembly);
  const aborter = useRef<AbortController | null>(null);
  useEffect(() => () => aborter.current?.abort(), []);
  // The arrangement as last drawn, read when an answer arrives.
  const latest = useRef(assembly.state);
  useEffect(() => {
    latest.current = assembly.state;
  });

  const messages = picked.reduce((sum, session) => sum + session.conversation.messages.length, 0);
  const eligible = picked.length >= 1 && picked.length <= EXPAND_MAX_SESSIONS && messages >= EXPAND_MIN_MESSAGES;
  const base = before ?? assembly.state;
  const { order, merges, edits } = base;
  const visible = useMemo(() => (eligible ? applySessionMerges(inOrder(picked, order), merges, edits) : null), [eligible, picked, order, merges, edits]);
  const rounds = useMemo(() => (visible ? roundCount(visible.sessions, visible.edits) : 0), [visible]);
  const [expand, setExpand] = useState(true);
  const splitting = eligible && expand && canExpand(rounds);

  /** Asks the server about the arrangement from before any analysis; applies the answer unless the user changed something meanwhile. */
  const analyze = async () => {
    if (request.kind === "busy") return;
    const start = assembly.state;
    const pre = before ?? start;
    const originals = inOrder(picked, pre.order);
    const shown = applySessionMerges(originals, pre.merges, pre.edits);
    const input = analysisInput(shown.sessions, shown.edits, pre.merges, splitting);
    if (input.units.length > IMPORT_ANALYZE_MAX_UNITS) return setRequest({ kind: "failed", reason: t("ai.tooMany", { max: IMPORT_ANALYZE_MAX_UNITS }) });
    aborter.current?.abort();
    const controller = new AbortController();
    aborter.current = controller;
    setRequest({ kind: "busy" });
    try {
      const title = assembly.organize.title.trim();
      const plan = await withRateLimitRetry(() => client.analyzeImport({ ...(title ? { title } : {}), units: input.units }, { signal: controller.signal }));
      if (controller.signal.aborted) return;
      if (changedSince(start, latest.current)) return setRequest({ kind: "failed", reason: t("ai.changed") });
      // B26: the server got the longer texts; everything analysed here afterwards reads the 300-rune excerpts, as before.
      const applied = applyAnalysis({ plan, units: analyzeExcerpts(input.units), unitSessions: input.unitSessions, baseMerges: input.baseMerges }, plan, originals, input.unitSessions ? undefined : pre.edits.messages);
      setBefore(pre);
      fineTune.clearExpanded();
      ai.clearRoundTimes();
      ai.setAnalysis(applied.analysis);
      assembly.restore(applied.state);
      setDrawn(applied.state);
      setRequest({ kind: "idle" });
    } catch (error) {
      if (!controller.signal.aborted) setRequest({ kind: "failed", reason: describeError(error, ui, hostErrorText) });
    }
  };

  const reset = () => {
    if (!before) return;
    aborter.current?.abort();
    ai.setAnalysis(null);
    ai.clearRoundTimes();
    assembly.restore(before);
    setBefore(null);
    setDrawn(null);
    setRequest({ kind: "idle" });
    assembly.say(t("ai.resetDone"));
  };

  return {
    eligible,
    rounds,
    expand,
    setExpand,
    /** Whether the rounds are split for the next analysis. */
    splitting,
    request,
    analysis: ai.analysis,
    analyzed: before !== null,
    /** F17: the tree was adjusted by hand since the analysis drew it (analyzing again asks first). */
    adjusted: drawn !== null && changedSince(drawn, assembly.state),
    analyze: () => void analyze(),
    reset,
    view: fineTune.view,
  };
}

export type AiTree = ReturnType<typeof useAiTree>;
export type { AiTreeView } from "./use-ai-fine-tune";
