import type { Fold } from "../fold-routes";
import type { RecalledMemory } from "../memory-routes";
import { TangentError } from "../errors";
import type { Group } from "../group-routes";
import type { LineView } from "../types";
import type { MockBus } from "./mock-bus";
import { findLine, recount, rootOf, withLine, type MockState } from "./mock-store";
import type { MockScenario } from "./scenario";

export interface MockTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** What every group of mock operations shares: the current state, the bus, the clock and timers. */
export interface MockContext {
  state(): MockState;
  commit(next: MockState): void;
  bus: MockBus;
  scenario: MockScenario;
  /** ISO time of "now". */
  now(): string;
  timers: MockTimers;
  chunkMs: number;
  draftMs: number;
  /** B9 phase C: groups whose summary is ready (the fisheye report shows them instead of their members). */
  readyGroups?: (rootLineId: string) => readonly Group[];
  /** B10 phase A: a line's active folds (the preview sends their summaries instead of their messages). */
  activeFolds?: (lineId: string) => readonly Fold[];
  /** B10 phase C: the memories a turn recalls for `query`, and the trailing block they make. */
  recallMemories?: (query: string) => { results: readonly RecalledMemory[]; block: string };
  /** Called after a turn finished well, with the user's message (the suggestion probe listens). */
  afterTurn?: (lineId: string, userContent: string) => void;
}

/** The error the mock raises for routes it does not simulate yet. */
export function unsupported(route: string): TangentError {
  return new TangentError(501, `${route} is not simulated by the mock client`, "mock_unsupported");
}

/** Publishes `line.updated` for a line with fresh counts, committing the recount. */
export function publishLine(ctx: MockContext, lineId: string): LineView {
  const line = recount(ctx.state(), lineId);
  ctx.commit(withLine(ctx.state(), line));
  ctx.bus.publish("line.updated", { lineId: line.id, rootLineId: rootOf(line) }, line);
  return line;
}

/** The event address of a line. */
export function address(ctx: MockContext, lineId: string): { lineId: string; rootLineId: string } {
  return { lineId, rootLineId: rootOf(findLine(ctx.state(), lineId)) };
}
