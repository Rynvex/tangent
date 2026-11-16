import { describe, expect, it } from "vitest";
import {
  canAnchorBranch,
  canCarryCardPremise,
  cardMessageIds,
  cardState,
  classifyCardEditError,
  editedCardSource,
  followUpsOfCard,
  isoMicros,
  normalizeUpdateBranchCardResult,
} from "./b17-routes";
import { normalizeBranchView } from "./branch-normalize";
import { normalizeMessage } from "./line-normalize";
import { cardRequestBody, emptyCard } from "./branch-card";
import { TangentError } from "./errors";
import { fixture } from "./testing/scenario";

const message = (raw: Record<string, unknown>) => fixture.message({ id: "m", seq: 1, lineId: "main", role: "assistant", kind: "chat", status: "done", content: "", ...raw });
const branch = (raw: Record<string, unknown>) => fixture.branch({ lineId: "b", parentLineId: "main", rootLineId: "main", status: "open", createdAt: "2026-01-01T00:00:00Z", ...raw });

describe("PATCH /branch/card result", () => {
  it("reads the branch and the card, without a delivered flag", () => {
    const result = normalizeUpdateBranchCardResult({
      branch: { lineId: "b", status: "merged", conclusionLine: "new" },
      message: { id: "c", kind: "branch_card", role: "system", status: "done", meta: { branchLineId: "b", card: { question: "q", conclusion: "new" } } },
    });
    expect(result.branch).toMatchObject({ lineId: "b", status: "merged", conclusionLine: "new" });
    expect(result.message.meta.card?.conclusion).toBe("new");
    expect("delivered" in result.message.meta).toBe(false);
  });

  it("reads the edit time on the card and on its branch (B17.1), and leaves out an empty or mistyped one", () => {
    const result = normalizeUpdateBranchCardResult({
      branch: { lineId: "b", status: "merged", cardEditedAt: "2026-10-30T08:15:42.123456Z" },
      message: { id: "c", kind: "branch_card", meta: { editedAt: "2026-10-30T08:15:42.123456Z" } },
    });
    expect(result.branch.cardEditedAt).toBe("2026-10-30T08:15:42.123456Z");
    expect(result.message.meta.editedAt).toBe("2026-10-30T08:15:42.123456Z");
    expect("cardEditedAt" in normalizeBranchView({ cardEditedAt: "" })).toBe(false);
    expect("cardEditedAt" in normalizeBranchView({ cardEditedAt: 5 })).toBe(false);
    expect("editedAt" in normalizeMessage({ meta: { editedAt: "" } }).meta).toBe(false);
    expect("editedAt" in normalizeMessage({ meta: { editedAt: null } }).meta).toBe(false);
  });

  it("tolerates a body with nothing in it", () => {
    const result = normalizeUpdateBranchCardResult(null);
    expect(result.branch.lineId).toBe("");
    expect(result.message.id).toBe("");
  });
});

describe("classifyCardEditError", () => {
  it("names the refusals the dialog words differently", () => {
    expect(classifyCardEditError(new TangentError(409, "busy", "parent_busy"))).toEqual({ kind: "parent_busy" });
    expect(classifyCardEditError(new TangentError(409, "closed", "parent_closed"))).toEqual({ kind: "parent_closed" });
    expect(classifyCardEditError(new TangentError(409, "archived", "archived"))).toEqual({ kind: "archived" });
    expect(classifyCardEditError(new TangentError(409, "closed", "branch_closed"))).toEqual({ kind: "branch_closed" });
    expect(classifyCardEditError(new TangentError(422, "bad", "invalid_card", { problems: [{ field: "question", message: "required" }, { nope: 1 }] }))).toEqual({
      kind: "invalid_card",
      problems: [{ field: "question", message: "required" }],
    });
  });

  it("keeps anything else as the error itself", () => {
    const network = new Error("offline");
    expect(classifyCardEditError(network)).toEqual({ kind: "other", error: network });
    const notFound = new TangentError(404, "gone", "branch_not_found");
    expect(classifyCardEditError(notFound)).toEqual({ kind: "other", error: notFound });
  });
});

describe("cardRequestBody", () => {
  it("sends only what is filled, trimmed (the server decodes strictly)", () => {
    const card = { ...emptyCard(), question: " Tomatoes or peppers? ", conclusion: "Tomatoes first ", openItems: ["Buy seedlings", "  "] };
    expect(cardRequestBody(card)).toStrictEqual({ question: "Tomatoes or peppers?", conclusion: "Tomatoes first", openItems: ["Buy seedlings"] });
  });
});

describe("cardState", () => {
  it("is delivered once a turn carried it (edited or not), edited and waiting with an edit time, else pending: the server's data alone", () => {
    expect(cardState(message({ meta: { delivered: true } }))).toBe("delivered");
    expect(cardState(message({ meta: { delivered: true, editedAt: "2026-10-30T08:00:00Z" } }))).toBe("delivered");
    expect(cardState(message({ meta: { editedAt: "2026-10-30T08:00:00Z" } }))).toBe("editedPending");
    // No transcript guess: a card past NoticeMaxPerTurn stays undelivered after a finished reply and is still just pending.
    expect(cardState(message({ meta: {} }))).toBe("pending");
  });
});

describe("isoMicros", () => {
  it("keeps the server's microseconds, which Date.parse drops", () => {
    expect(isoMicros("2026-10-30T08:15:42.123456Z")).toBe(Date.parse("2026-10-30T08:15:42.123Z") * 1000 + 456);
    expect(isoMicros("2026-10-30T08:15:42.123901Z")).toBeGreaterThan(isoMicros("2026-10-30T08:15:42.1234Z"));
    expect(isoMicros("2026-10-30T08:15:42Z")).toBe(Date.parse("2026-10-30T08:15:42Z") * 1000);
    expect(isoMicros("2026-10-30T08:15:42.5Z")).toBe(Date.parse("2026-10-30T08:15:42.5Z") * 1000);
    expect(isoMicros("not a time")).toBeNaN();
  });
});

describe("follow-ups from a card", () => {
  it("anchors on finished chat messages and conclusion cards only", () => {
    expect(canAnchorBranch(message({}))).toBe(true);
    expect(canAnchorBranch(message({ role: "user" }))).toBe(true);
    expect(canAnchorBranch(message({ kind: "branch_card", role: "system" }))).toBe(true);
    expect(canAnchorBranch(message({ kind: "branch_marker", role: "system" }))).toBe(false);
    expect(canAnchorBranch(message({ role: "system" }))).toBe(false);
    expect(canAnchorBranch(message({ status: "pending" }))).toBe(false);
  });

  it("finds the branches opened from a card, and those opened before its edit by the server's times (open and merged only)", () => {
    const source = branch({ lineId: "src", status: "merged", cardMessageId: "card", cardEditedAt: "2026-01-02T10:00:00.000500Z" });
    const early = branch({ lineId: "early", anchorMessageId: "card", createdAt: "2026-01-02T09:00:00Z" });
    // Opened in the same millisecond as the edit, a few microseconds before it.
    const justBefore = branch({ lineId: "justBefore", anchorMessageId: "card", createdAt: "2026-01-02T10:00:00.000100Z" });
    const late = branch({ lineId: "late", anchorMessageId: "card", createdAt: "2026-01-02T11:00:00Z" });
    const returned = branch({ lineId: "returned", anchorMessageId: "card", status: "merged" });
    const dropped = branch({ lineId: "dropped", anchorMessageId: "card", status: "discarded" });
    const elsewhere = branch({ lineId: "other", anchorMessageId: "m1" });
    const all = [source, early, justBefore, late, returned, dropped, elsewhere];
    expect([...cardMessageIds(all)]).toEqual(["card"]);
    expect(followUpsOfCard(all, "card").map((item) => item.lineId)).toEqual(["early", "justBefore", "late", "returned", "dropped"]);
    expect(followUpsOfCard(all, "")).toEqual([]);
    expect(all.filter((item) => editedCardSource(item, all) !== null).map((item) => item.lineId)).toEqual(["early", "justBefore", "returned"]);
    expect(editedCardSource(early, all)).toBe(source);
    expect(canCarryCardPremise({ status: "open" })).toBe(true);
    expect(canCarryCardPremise({ status: "promoted" })).toBe(false);
    // A card never edited marks nothing; a chat message is no card; without the source in the outline nothing is known.
    expect(editedCardSource(early, [{ ...source, cardEditedAt: undefined }, early])).toBeNull();
    expect(editedCardSource(elsewhere, all)).toBeNull();
    expect(editedCardSource(early, [early])).toBeNull();
  });
});

describe("cardEditReasons (decision #6)", () => {
  it("names the card a follow-up came from when it was edited after the follow-up opened; 知道了 hides that edit only", async () => {
    const { cardEditReasons } = await import("./stale-reasons");
    const source = branch({ lineId: "src", status: "merged", cardMessageId: "card", purpose: "Koch snowflake", cardEditedAt: "2026-01-02T00:00:00.5Z" });
    const followUp = branch({ lineId: "f", anchorMessageId: "card" });
    const [reason] = cardEditReasons(followUp, [source, followUp]);
    expect(reason).toEqual({ kind: "cardEdited", id: "card:card:2026-01-02T00:00:00.5Z", cardMessageId: "card", cardLineId: "main", title: "Koch snowflake" });
    expect(cardEditReasons(followUp, [source, followUp], new Set([reason!.id]))).toEqual([]);
    // Edited again: a new reason, 知道了 on the first one does not hide it.
    const again = { ...source, cardEditedAt: "2026-01-03T00:00:00Z" };
    expect(cardEditReasons(followUp, [again, followUp], new Set([reason!.id]))).toMatchObject([{ id: "card:card:2026-01-03T00:00:00Z" }]);
    // A follow-up opened after the edit, and a discarded one, carry no reason.
    expect(cardEditReasons({ ...followUp, createdAt: "2026-01-02T00:00:01Z" }, [source, followUp])).toEqual([]);
    expect(cardEditReasons({ ...followUp, status: "discarded" }, [source, followUp])).toEqual([]);
  });
});
