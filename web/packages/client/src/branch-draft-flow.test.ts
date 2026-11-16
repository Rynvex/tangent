import { describe, expect, it } from "vitest";
import { normalizeBranchDraft } from "./branch-normalize";
import { DRAFT_CLOCK_SKEW_MS, DRAFT_TIMEOUT_MS, draftFlowReducer, initialDraftFlow, isDraftOverdue } from "./branch-draft-flow";
import { emptyCard } from "./branch-card";
import { TangentError } from "./errors";

const NOW = Date.parse("2026-01-01T00:10:00Z");
const readyCard = { ...emptyCard(), question: "q", conclusion: "c" };

describe("draftFlowReducer", () => {
  it("goes none -> drafting -> ready with the warnings", () => {
    let state = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "claude", model: "haiku" });
    expect(state.phase).toBe("drafting");
    state = draftFlowReducer(state, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "drafting", startedAt: "2026-01-01T00:09:00Z" }) });
    expect(state.phase).toBe("drafting");
    state = draftFlowReducer(state, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "ready", card: readyCard, warnings: ["dropped 1"] }) });
    expect(state).toMatchObject({ phase: "review", source: "ai", warnings: ["dropped 1"] });
    expect(state.card.question).toBe("q");
  });

  it("falls back to a blank manual card when the draft failed", () => {
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "claude", model: "" });
    const state = draftFlowReducer(drafting, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "failed", error: "the drafting run failed" }) });
    expect(state).toMatchObject({ phase: "review", source: "manual", notice: { code: "draft_failed", text: "the drafting run failed" } });
    expect(state.card).toEqual(emptyCard());
  });

  it("treats a draft older than the timeout plus the skew margin as failed", () => {
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "", model: "" });
    const startedAt = new Date(NOW - DRAFT_TIMEOUT_MS - DRAFT_CLOCK_SKEW_MS - 1000).toISOString();
    const state = draftFlowReducer(drafting, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "drafting", startedAt }) });
    expect(state).toMatchObject({ phase: "review", source: "manual", notice: { code: "draft_timeout" } });
  });

  it("goes straight to manual when card drafting is turned off", () => {
    const state = draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TangentError(409, "none", "feature_disabled") });
    expect(state).toMatchObject({ phase: "review", source: "manual", notice: { code: "feature_disabled" } });
  });

  it("blocks on a busy branch but resumes an already running draft", () => {
    const busy = draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TangentError(409, "busy", "branch_busy") });
    expect(busy.phase).toBe("blocked");
    const running = draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TangentError(409, "x", "branch_drafting") });
    expect(running.phase).toBe("drafting");
  });

  it("abandoning swaps in a blank card and a late result cannot overwrite it", () => {
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "claude", model: "" });
    const abandoned = draftFlowReducer(drafting, { type: "abandon" });
    expect(abandoned).toMatchObject({ phase: "review", source: "manual", notice: { code: "abandoned" } });
    const typed = { ...abandoned, card: { ...abandoned.card, question: "mine" } };
    const late = draftFlowReducer(typed, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "ready", card: readyCard }) });
    expect(late.card.question).toBe("mine");
    expect(late.source).toBe("manual");
  });
});

describe("draftFlowReducer card edits", () => {
  it("edits the card in review and marks it edited", () => {
    const manualState = draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TangentError(409, "x", "feature_disabled") });
    const next = draftFlowReducer(manualState, { type: "card", action: { type: "setText", field: "question", value: "why" } });
    expect(next.card.question).toBe("why");
    expect(next.edited).toBe(true);
    expect(manualState.card.question).toBe("");
  });
});

describe("draftFlowReducer start failures", () => {
  it("writes the card by hand when the branch has nothing to draft from", () => {
    const state = draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TangentError(409, "empty", "no_messages") });
    expect(state).toMatchObject({ phase: "review", source: "manual", notice: { code: "no_messages", text: "empty" } });
  });

  it("falls back to a manual card on a network or server failure", () => {
    expect(draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TangentError(500, "boom") }).notice).toEqual({ code: "start_failed", text: "boom" });
    expect(draftFlowReducer(initialDraftFlow(), { type: "startFailed", error: new TypeError("offline") }).notice).toEqual({ code: "start_failed", text: "" });
  });

  it("ignores a draft with no start time when judging the timeout", () => {
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "", model: "" });
    const state = draftFlowReducer(drafting, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "drafting", startedAt: null }) });
    expect(state.phase).toBe("drafting");
  });

  it("restarts from scratch", () => {
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "p", model: "m" });
    expect(draftFlowReducer(drafting, { type: "restart" })).toEqual(initialDraftFlow());
  });
});

describe("draft timeout and clock skew (review LOW)", () => {
  const started = new Date(NOW - DRAFT_TIMEOUT_MS - 30_000).toISOString();

  it("keeps waiting when the browser clock is only a little past the server's deadline", () => {
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "", model: "" });
    const state = draftFlowReducer(drafting, { type: "serverDraft", now: NOW, draft: normalizeBranchDraft({ status: "drafting", startedAt: started }) });
    expect(state.phase).toBe("drafting");
    expect(isDraftOverdue(started, NOW)).toBe(false);
  });

  it("trusts a server clock without the margin when the host has one", () => {
    expect(isDraftOverdue(started, NOW, NOW)).toBe(true);
    expect(isDraftOverdue(started, NOW + 10 * 60_000, NOW - 60_000)).toBe(false);
    const drafting = draftFlowReducer(initialDraftFlow(), { type: "started", provider: "", model: "" });
    const state = draftFlowReducer(drafting, { type: "serverDraft", now: NOW, serverNow: NOW, draft: normalizeBranchDraft({ status: "drafting", startedAt: started }) });
    expect(state.notice?.code).toBe("draft_timeout");
  });
});
