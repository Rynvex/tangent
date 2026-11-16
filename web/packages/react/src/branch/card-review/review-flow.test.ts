import { emptyCard, initialDraftFlow, TangentError, type BranchDraft, type DraftFlowState } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { reviewFlowReducer, type ReviewFlowEvent } from "./review-flow";

const prefilled = { ...emptyCard(), question: "Which disks?", conclusion: "Two 8TB disks." };
const aiCard = { ...emptyCard(), question: "Which disks?", conclusion: "8TB costs less per TB.", impact: "Buy two." };

const run = (events: ReviewFlowEvent[], start: DraftFlowState = initialDraftFlow()) => events.reduce(reviewFlowReducer, start);
const draft = (over: Partial<BranchDraft>): BranchDraft => ({ status: "drafting", card: null, warnings: [], error: "", provider: "fake", model: "m", startedAt: new Date().toISOString(), uptoSeq: 5, parentTipMessageId: "p1", manualCardAvailable: true, noteChanges: [], ...over });
const asking: ReviewFlowEvent[] = [{ type: "prefill", card: prefilled }, { type: "card", action: { type: "setText", field: "conclusion", value: "Typed by me." } }, { type: "started", provider: "fake", model: "m" }];

describe("reviewFlowReducer", () => {
  it("opens the review with the prefilled card, no draft running", () => {
    const state = run([{ type: "prefill", card: prefilled }]);
    expect(state).toMatchObject({ phase: "review", source: "manual", card: prefilled, notice: null, edited: false });
  });

  it("replaces the card with the AI draft once it is ready", () => {
    const state = run([...asking, { type: "serverDraft", draft: draft({ status: "ready", card: aiCard }), now: Date.now() }]);
    expect(state).toMatchObject({ phase: "review", source: "ai", card: aiCard });
  });

  it("keeps what the user typed when the draft fails, is stopped or cannot start", () => {
    const failed = run([...asking, { type: "serverDraft", draft: draft({ status: "failed", error: "quota" }), now: Date.now() }]);
    expect(failed).toMatchObject({ phase: "review", source: "manual", notice: { code: "draft_failed", text: "quota" } });
    expect(failed.card.conclusion).toBe("Typed by me.");
    const stopped = run([...asking, { type: "abandon" }]);
    expect(stopped.card.conclusion).toBe("Typed by me.");
    expect(stopped.notice?.code).toBe("abandoned");
    const refused = run([asking[0]!, asking[1]!, { type: "startFailed", error: new TangentError(500, "boom", "internal") }]);
    expect(refused).toMatchObject({ phase: "review", notice: { code: "start_failed" } });
    expect(refused.card.conclusion).toBe("Typed by me.");
    const busy = run([asking[0]!, { type: "startFailed", error: new TangentError(409, "busy", "line_busy") }]);
    expect(busy).toMatchObject({ phase: "review", card: prefilled, notice: { code: "line_busy" } });
  });

  it("keeps an AI card as an AI card when drafting again fails", () => {
    const ai = run([...asking, { type: "serverDraft", draft: draft({ status: "ready", card: aiCard }), now: Date.now() }]);
    const again = run([{ type: "started", provider: "fake", model: "m" }, { type: "serverDraft", draft: draft({ status: "failed" }), now: Date.now() }], ai);
    expect(again).toMatchObject({ phase: "review", source: "ai", card: aiCard });
  });

  it("waits while a refused start says a draft is already running", () => {
    const state = run([asking[0]!, { type: "startFailed", error: new TangentError(409, "", "branch_drafting") }]);
    expect(state.phase).toBe("drafting");
    expect(run([{ type: "abandon" }], state).card).toEqual(prefilled);
  });

  it("leaves a blank card when the branch cannot even be read", () => {
    const state = run([{ type: "startFailed", error: new TangentError(500, "down", "internal") }]);
    expect(state).toMatchObject({ phase: "review", card: emptyCard(), notice: { code: "start_failed" } });
  });
});
