import { cardReducer, emptyCard, type CardAction } from "./branch-card";
import { TangentError } from "./errors";
import type { BranchCard, BranchDraft } from "./types";
import { DRAFT_CLOCK_SKEW_MS, DRAFT_TIMEOUT_MS } from "./branch-draft-timing";

export { DRAFT_CLOCK_SKEW_MS, DRAFT_POLL_MS, DRAFT_TIMEOUT_MS } from "./branch-draft-timing";

/** Codes of a refused draft start that mean "write the card by hand". */
const MANUAL_ONLY_CODES: ReadonlySet<string> = new Set([
  // The card_draft feature is off for this tenant (DESIGN §11).
  "feature_disabled",
  "no_messages",
]);

export type DraftPhase = "starting" | "drafting" | "review" | "blocked";

export interface DraftFlowState {
  phase: DraftPhase;
  /** Where the card in review came from: `ai` still needs the reviewed tick. */
  source: "ai" | "manual";
  card: BranchCard;
  warnings: string[];
  /** Why the card is a manual one (failed draft, no provider, abandoned), or why the flow is blocked. */
  notice: { code: string; text: string } | null;
  provider: string;
  model: string;
  /** True once the user typed into an AI card: a later server result must not replace it. */
  edited: boolean;
}

export type DraftFlowEvent =
  | { type: "started"; provider: string; model: string }
  | { type: "startFailed"; error: unknown }
  /**
   * `now` is the browser clock. `serverNow`, when the host has it (e.g. the
   * response's Date header), is the server clock and is judged without the
   * skew margin.
   */
  | { type: "serverDraft"; draft: BranchDraft; now: number; serverNow?: number }
  | { type: "abandon" }
  | { type: "card"; action: CardAction }
  | { type: "restart" };

export function initialDraftFlow(): DraftFlowState {
  return { phase: "starting", source: "manual", card: emptyCard(), warnings: [], notice: null, provider: "", model: "", edited: false };
}

function manual(state: DraftFlowState, notice: DraftFlowState["notice"]): DraftFlowState {
  return { ...state, phase: "review", source: "manual", card: emptyCard(), warnings: [], notice, edited: false };
}

function startFailed(state: DraftFlowState, error: unknown): DraftFlowState {
  const code = error instanceof TangentError ? error.code : "";
  const text = error instanceof TangentError ? error.message : "";
  if (code === "branch_drafting") return { ...state, phase: "drafting", notice: null };
  if (MANUAL_ONLY_CODES.has(code)) return manual(state, { code, text });
  if (error instanceof TangentError && error.status === 409) return { ...state, phase: "blocked", notice: { code, text } };
  return manual(state, { code: "start_failed", text });
}

/** True when a running draft is past the server's timeout. */
export function isDraftOverdue(startedAt: string | null, now: number, serverNow?: number): boolean {
  const started = Date.parse(startedAt ?? "");
  if (!Number.isFinite(started)) return false;
  if (serverNow !== undefined && Number.isFinite(serverNow)) return serverNow - started > DRAFT_TIMEOUT_MS;
  return now - started > DRAFT_TIMEOUT_MS + DRAFT_CLOCK_SKEW_MS;
}

function serverDraft(state: DraftFlowState, draft: BranchDraft, now: number, serverNow?: number): DraftFlowState {
  // A late result never overwrites a card the user is already working on.
  if (state.phase !== "drafting" && state.phase !== "starting") return state;
  if (draft.status === "ready" && draft.card) {
    return { ...state, phase: "review", source: "ai", card: draft.card, warnings: draft.warnings, notice: null, provider: draft.provider || state.provider, model: draft.model || state.model, edited: false };
  }
  if (draft.status === "failed") return manual(state, { code: "draft_failed", text: draft.error });
  if (draft.status === "drafting" && isDraftOverdue(draft.startedAt, now, serverNow)) {
    return manual(state, { code: "draft_timeout", text: draft.error });
  }
  if (draft.status === "drafting") return { ...state, phase: "drafting", provider: draft.provider || state.provider, model: draft.model || state.model };
  return state;
}

export function draftFlowReducer(state: DraftFlowState, event: DraftFlowEvent): DraftFlowState {
  switch (event.type) {
    case "started":
      return { ...state, phase: "drafting", provider: event.provider, model: event.model, notice: null };
    case "startFailed":
      return startFailed(state, event.error);
    case "serverDraft":
      return serverDraft(state, event.draft, event.now, event.serverNow);
    case "abandon":
      return state.phase === "drafting" ? manual(state, { code: "abandoned", text: "" }) : state;
    case "card":
      return { ...state, card: cardReducer(state.card, event.action), edited: true };
    case "restart":
      return initialDraftFlow();
  }
}
