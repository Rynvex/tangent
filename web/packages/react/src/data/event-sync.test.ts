import { normalizeLine, normalizeMessage, type LinePage, type LineView, type MessagePage, type TangentEvent } from "@tangent/client";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { tangentKeys } from "../query-keys";
import { applyEvent, createEventSync, resyncAll, type SyncTarget } from "./event-sync";
import { createLiveStore } from "./live-store";
import { optimisticUserMessage } from "./message-cache";

const keys = tangentKeys({ baseUrl: "/api" });
const line = (id: string, over: Record<string, unknown> = {}): LineView => normalizeLine({ id, title: id, ...over });
const message = (id: string, seq: number, over: Record<string, unknown> = {}) => normalizeMessage({ id, seq, lineId: "l1", role: "assistant", status: "done", content: id, ...over });
const event = (type: string, data: unknown, lineId = "l1", rootLineId = "l1") => ({ type, tenant: "", lineId, rootLineId, data }) as TangentEvent;

let target: SyncTarget;
/** Lets TanStack's notification batch (a zero timer) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  target = { queryClient: new QueryClient(), keys, live: createLiveStore() };
});

const messages = () => target.queryClient.getQueryData<MessagePage>(keys.messages("l1"))?.messages.map((m) => `${m.id}:${m.status}`);

describe("applyEvent: messages", () => {
  it("adds created messages and replaces updated ones in a cached page, by seq", () => {
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [message("a", 1)] });
    applyEvent(target, event("message.created", message("p", 3, { status: "pending" })));
    applyEvent(target, event("message.created", message("u", 2, { role: "user" })));
    expect(messages()).toEqual(["a:done", "u:done", "p:pending"]);
    applyEvent(target, event("message.updated", message("p", 3)));
    expect(messages()).toEqual(["a:done", "u:done", "p:done"]);
  });

  it("B7.2: a host's notice after a streaming reply goes after it by seq, leaves the stream alone and makes the next turn's preview stale", () => {
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [message("u", 1, { role: "user" })] });
    applyEvent(target, event("message.created", message("p", 2, { status: "pending" })));
    applyEvent(target, event("message.delta", { turnId: "p", seq: 10, kind: "text", text: "Hel" }));
    target.queryClient.setQueryData(keys.preview("l1", "next"), {});
    applyEvent(target, event("message.created", message("n", 3, { role: "system", kind: "chat", content: "Host: build started" })));
    expect(messages()).toEqual(["u:done", "p:pending", "n:done"]);
    expect(target.live.getState().streams.l1?.text).toBe("Hel");
    expect(target.queryClient.getQueryState(keys.preview("l1", "next"))?.isInvalidated).toBe(true);
    applyEvent(target, event("message.delta", { turnId: "p", seq: 11, kind: "text", text: "lo" }));
    expect(target.live.getState().streams.l1?.text).toBe("Hello");
  });

  it("does not create a page for a line nobody shows", () => {
    applyEvent(target, event("message.created", message("a", 1)));
    expect(target.queryClient.getQueryData(keys.messages("l1"))).toBeUndefined();
  });

  it("leaves the optimistic copy alone (the send result removes it by id), even when the text matches", () => {
    const optimistic = optimisticUserMessage("l1", "hi", 1);
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [message("a", 1), optimistic] });
    applyEvent(target, event("message.created", message("u", 2, { role: "user", content: "hi" })));
    expect(messages()).toEqual(["a:done", "u:done", `${optimistic.id}:done`]);
  });

  it("streams deltas into the live store and ends the stream when the reply is no longer pending", async () => {
    applyEvent(target, event("message.delta", { turnId: "p", seq: 10, kind: "text", text: "Hel" }));
    applyEvent(target, event("message.delta", { turnId: "p", seq: 11, kind: "text", text: "lo" }));
    expect(target.live.getState().streams.l1?.text).toBe("Hello");
    applyEvent(target, event("message.updated", message("p", 3, { status: "pending" })));
    expect(target.live.getState().streams.l1).toBeDefined();
    target.queryClient.setQueryData(keys.preview("l1", "next"), {});
    applyEvent(target, event("message.updated", message("p", 3)));
    await tick();
    expect(target.live.getState().streams.l1).toBeUndefined();
    expect(target.queryClient.getQueryState(keys.preview("l1", "next"))?.isInvalidated).toBe(true);
  });

  it("queues an update while the page is loading and applies it when the load lands, without restarting the load", async () => {
    const sync = createEventSync(target);
    let resolve: (page: MessagePage) => void = () => undefined;
    let fetches = 0;
    const loading = target.queryClient.fetchQuery({
      queryKey: keys.messages("l1"),
      queryFn: () => {
        fetches += 1;
        return new Promise<MessagePage>((done) => (resolve = done));
      },
    });
    sync.apply(event("message.created", message("b", 2)));
    resolve({ messages: [message("a", 1)] });
    await loading;
    expect(fetches).toBe(1);
    expect(messages()).toEqual(["a:done", "b:done"]);
    sync.dispose();
  });
});

describe("applyEvent: lines", () => {
  it("updates the line view and its row in every cached list", () => {
    target.queryClient.setQueryData(keys.lineView("l1"), line("l1"));
    target.queryClient.setQueryData<LinePage>(keys.lines({}), { lines: [line("l1"), line("l2")], nextCursor: "" });
    applyEvent(target, event("line.updated", line("l1", { status: "thinking", title: "New" })));
    expect(target.queryClient.getQueryData<LineView>(keys.lineView("l1"))?.status).toBe("thinking");
    expect(target.queryClient.getQueryData<LinePage>(keys.lines({}))?.lines.map((l) => l.title)).toEqual(["New", "l2"]);
  });

  it("invalidates the lists when a main line is created or changes archive state", () => {
    target.queryClient.setQueryData<LinePage>(keys.lines({}), { lines: [line("l1")], nextCursor: "" });
    applyEvent(target, event("line.created", line("l9"), "l9", "l9"));
    expect(target.queryClient.getQueryState(keys.lines({}))?.isInvalidated).toBe(true);
    target.queryClient.setQueryData<LinePage>(keys.lines({}), { lines: [line("l1")], nextCursor: "" });
    applyEvent(target, event("line.updated", line("l1", { archivedAt: "2026-01-01T00:00:00Z" })));
    expect(target.queryClient.getQueryState(keys.lines({}))?.isInvalidated).toBe(true);
  });

  it("B18.1: reloads the tenant's folder and tag counts for a main line created or deleted, or a folder, tags or archive change", () => {
    const fresh = () => target.queryClient.setQueryData(keys.lineOrganization(), { folders: [], tags: [] });
    const stale = () => target.queryClient.getQueryState(keys.lineOrganization())?.isInvalidated;
    target.queryClient.setQueryData(keys.lineView("l1"), line("l1"));
    fresh();
    applyEvent(target, event("line.updated", line("l1", { title: "renamed" })));
    expect(stale()).toBe(false);
    for (const change of [{ folder: "Work" }, { tags: ["go"] }, { archivedAt: "2026-01-01T00:00:00Z" }]) {
      target.queryClient.setQueryData(keys.lineView("l1"), line("l1"));
      fresh();
      applyEvent(target, event("line.updated", line("l1", change)));
      expect(stale(), JSON.stringify(change)).toBe(true);
    }
    fresh();
    applyEvent(target, event("line.created", line("b9", { conversationBranch: { parentLineId: "l1", rootLineId: "l1", anchorMessageId: "m", depth: 1, purpose: "p", kind: "investigate", status: "open", origin: "button" } }), "b9", "l1"));
    expect(stale()).toBe(false);
    applyEvent(target, event("line.created", line("l9"), "l9", "l9"));
    expect(stale()).toBe(true);
    fresh();
    applyEvent(target, event("line.deleted", { rootLineId: "l9", lineIds: ["l9"] }, "l9", "l9"));
    expect(stale()).toBe(true);
  });

  it("removes deleted lines from the lists and drops their queries", () => {
    target.queryClient.setQueryData<LinePage>(keys.lines({}), { lines: [line("l1"), line("l2")], nextCursor: "" });
    target.queryClient.setQueryData(keys.lineView("l1"), line("l1"));
    applyEvent(target, event("line.deleted", { rootLineId: "l1", lineIds: ["l1", "b1"] }));
    expect(target.queryClient.getQueryData<LinePage>(keys.lines({}))?.lines.map((l) => l.id)).toEqual(["l2"]);
    expect(target.queryClient.getQueryData(keys.lineView("l1"))).toBeUndefined();
  });
});

describe("applyEvent: other events", () => {
  it("records retries, invalidates the tree's outline and chapters under the root (whatever line cached them) and notes", () => {
    const keysOf = [keys.branches("r", false), keys.branches("r", true), keys.branch("b1"), keys.notes("r"), keys.chapters("r"), keys.chapters("r", "b1")];
    for (const key of keysOf) target.queryClient.setQueryData(key, {});
    applyEvent(target, event("turn.retrying", { turnId: "p", attempt: 1, maxAttempts: 2, nextRetryAt: "" }));
    expect(target.live.getState().retrying.l1?.turnId).toBe("p");
    applyEvent(target, event("branch.changed", { change: "created", branch: { lineId: "b1", rootLineId: "r" } }, "b1", "r"));
    applyEvent(target, event("notes.changed", { rootLineId: "r", revision: 2 }, "r", "r"));
    applyEvent(target, event("chapters.changed", { rootLineId: "r" }, "r", "r"));
    for (const key of keysOf) {
      expect(target.queryClient.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
  });

  it("batches deltas until the next frame, and writes them before the reply's end", async () => {
    const frames: Array<() => void> = [];
    const sync = createEventSync(target, { schedule: (flush) => frames.push(flush) });
    sync.apply(event("message.delta", { turnId: "p", seq: 1, kind: "text", text: "a" }));
    sync.apply(event("message.delta", { turnId: "p", seq: 2, kind: "text", text: "b" }));
    expect(frames).toHaveLength(1);
    expect(target.live.getState().streams.l1).toBeUndefined();
    frames[0]!();
    expect(target.live.getState().streams.l1?.text).toBe("ab");
    sync.apply(event("message.delta", { turnId: "p", seq: 3, kind: "text", text: "c" }));
    sync.apply(event("message.updated", message("p", 3)));
    // The stream ends in the query notification batch, with the message update.
    expect(target.live.getState().streams.l1?.text).toBe("abc");
    await tick();
    expect(target.live.getState().streams.l1).toBeUndefined();
    expect(target.live.getState().finished.l1).toBe("p");
    sync.dispose();
  });

  it("forgets deleted lines in the live store", () => {
    applyEvent(target, event("message.delta", { turnId: "p", seq: 1, kind: "text", text: "a" }));
    applyEvent(target, event("line.deleted", { rootLineId: "l1", lineIds: ["l1"] }));
    expect(target.live.getState().streams).toEqual({});
  });

  it("resyncs everything on stream.lagged", () => {
    target.queryClient.setQueryData(keys.lineView("l1"), line("l1"));
    applyEvent(target, event("stream.lagged", {}));
    expect(target.queryClient.getQueryState(keys.lineView("l1"))?.isInvalidated).toBe(true);
    expect(target.live.getState().resyncEpoch).toBe(1);
  });

  it("resyncAll invalidates every Tangent query and bumps the stream epoch", () => {
    target.queryClient.setQueryData(keys.capabilities(), { features: [] });
    target.queryClient.setQueryData(["host", "other"], 1);
    resyncAll(target);
    expect(target.queryClient.getQueryState(keys.capabilities())?.isInvalidated).toBe(true);
    expect(target.queryClient.getQueryState(["host", "other"])?.isInvalidated).toBe(false);
  });
});

describe("applyEvent: the branch flow (F2)", () => {
  it("marks the cards a finished turn carried as delivered (the server sends no event for them)", () => {
    const card = message("c1", 1, { role: "system", kind: "branch_card", meta: { branchLineId: "b1" } });
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [card, message("p", 2, { status: "pending", meta: { deliversCards: ["c1"] } })] });
    applyEvent(target, event("message.updated", message("p", 2, { meta: { deliversCards: ["c1"] } })));
    const page = target.queryClient.getQueryData<MessagePage>(keys.messages("l1"))!;
    expect(page.messages.find((m) => m.id === "c1")?.meta.delivered).toBe(true);
  });

  it("leaves the cards undelivered when the turn failed or was stopped", () => {
    const card = message("c1", 1, { role: "system", kind: "branch_card" });
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [card] });
    applyEvent(target, event("message.updated", message("p", 2, { status: "error", meta: { deliversCards: ["c1"] } })));
    applyEvent(target, event("message.updated", message("q", 3, { meta: { deliversCards: ["c1"], cancelled: true } })));
    expect(target.queryClient.getQueryData<MessagePage>(keys.messages("l1"))!.messages.find((m) => m.id === "c1")?.meta.delivered).toBeUndefined();
  });

  it("reloads the transcripts a move or a promotion rewrote", () => {
    const touched = [keys.messages("r"), keys.messages("b1"), keys.messages("prev"), keys.lineView("r")];
    for (const key of touched) target.queryClient.setQueryData(key, { messages: [] });
    applyEvent(target, event("branch.changed", { change: "moved", branch: { lineId: "b1", parentLineId: "r", rootLineId: "r" } }, "b1", "r"));
    for (const key of touched.slice(0, 2)) expect(target.queryClient.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    target.queryClient.setQueryData(keys.messages("prev"), { messages: [] });
    applyEvent(target, event("branch.changed", { change: "promoted", branch: { lineId: "prev", parentLineId: "r", rootLineId: "r" } }, "prev", "r"));
    expect(target.queryClient.getQueryState(keys.messages("prev"))?.isInvalidated).toBe(true);
  });
});

describe("applyEvent: a branch that changed elsewhere (R2)", () => {
  it("reloads the branch's line and its parent's, and the root's after a move or promotion", () => {
    const views = ["b1", "p1", "r"].map((id) => keys.lineView(id));
    for (const key of views) target.queryClient.setQueryData(key, line("x"));
    applyEvent(target, event("branch.changed", { change: "discarded", branch: { lineId: "b1", parentLineId: "p1", rootLineId: "r" } }, "b1", "r"));
    expect(views.map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, false]);
    applyEvent(target, event("branch.changed", { change: "promoted", branch: { lineId: "b1", parentLineId: "p1", rootLineId: "r" } }, "b1", "r"));
    expect(target.queryClient.getQueryState(views[2]!)?.isInvalidated).toBe(true);
  });
});

describe("applyEvent: F3", () => {
  it("a renamed branch (B5) reloads the outline, the branch and its line, so the path shows the new purpose", () => {
    const watched = [keys.branches("r", true), keys.branch("b1"), keys.lineView("b1")];
    for (const key of watched) target.queryClient.setQueryData(key, {});
    applyEvent(target, event("branch.changed", { change: "renamed", branch: { lineId: "b1", parentLineId: "r", rootLineId: "r" } }, "b1", "r"));
    expect(watched.map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, true]);
  });

  it("notes.changed reloads every cached preview too: the notes block is in every prompt of the tree", () => {
    const previews = [keys.preview("r", ""), keys.preview("b1", "draft")];
    for (const key of previews) target.queryClient.setQueryData(key, {});
    target.queryClient.setQueryData(keys.messages("b1"), { messages: [] });
    applyEvent(target, event("notes.changed", { rootLineId: "r", revision: 3 }, "r", "r"));
    expect(previews.map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true]);
    expect(target.queryClient.getQueryState(keys.messages("b1"))?.isInvalidated).toBe(false);
  });
});

describe("applyEvent: B9 (F5)", () => {
  const goal = { rootLineId: "r", text: "Plan", source: "manual", updatedBy: "u", createdAt: "", updatedAt: "" };

  it("goal.changed writes the tree's goal in place (null when cleared) and reloads the previews (the goal is in every prompt)", () => {
    target.queryClient.setQueryData(keys.preview("b1", "x"), {});
    applyEvent(target, event("goal.changed", { rootLineId: "r", goal }, "r", "r"));
    expect(target.queryClient.getQueryData(keys.goal("r"))).toEqual({ goal });
    expect(target.queryClient.getQueryState(keys.preview("b1", "x"))?.isInvalidated).toBe(true);
    applyEvent(target, event("goal.changed", { rootLineId: "r", goal: null }, "r", "r"));
    expect(target.queryClient.getQueryData(keys.goal("r"))).toEqual({ goal: null });
  });

  it("link.changed reloads the tree's links and relations", () => {
    for (const key of [keys.links("r"), keys.relations("r")]) target.queryClient.setQueryData(key, {});
    applyEvent(target, event("link.changed", { rootLineId: "r", link: { id: "x", kind: "relation" }, deleted: true }, "r", "r"));
    expect([keys.links("r"), keys.relations("r")].map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true]);
  });

  it("whatever changes an open loop reloads the open-loops views (per tree and across conversations)", () => {
    const views = [keys.openLoops("r"), keys.openLoops(null)];
    const reloads = [
      event("seeds.changed", { rootLineId: "r" }, "r", "r"),
      event("suggestion.changed", { rootLineId: "r", suggestion: { id: "s" } }, "r", "r"),
      event("notes.changed", { rootLineId: "r", revision: 1 }, "r", "r"),
      event("branch.changed", { change: "merged", branch: { lineId: "b1", parentLineId: "r", rootLineId: "r" } }, "b1", "r"),
    ];
    for (const change of reloads) {
      for (const key of views) target.queryClient.setQueryData(key, {});
      applyEvent(target, change);
      expect(views.map((key) => target.queryClient.getQueryState(key)?.isInvalidated), change.type).toEqual([true, true]);
    }
  });

  it("message.updated carries a pin into the cached page", () => {
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [message("a", 1)] });
    applyEvent(target, event("message.updated", message("a", 1, { pinned: true })));
    expect(target.queryClient.getQueryData<MessagePage>(keys.messages("l1"))?.messages[0]?.pinned).toBe(true);
  });
});

describe("applyEvent: B9 phase C (F5 phase 3)", () => {
  it("group.changed reloads the tree's groups and the previews (a ready group goes into the prompt through fisheye)", () => {
    for (const key of [keys.groups("r"), keys.preview("r", "")]) target.queryClient.setQueryData(key, {});
    applyEvent(target, event("group.changed", { rootLineId: "r", group: { id: "g", summaryStatus: "ready" } }, "r", "r"));
    expect([keys.groups("r"), keys.preview("r", "")].map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true]);
  });

  it("job.failed is remembered by job, for whoever waits on it", () => {
    applyEvent(target, event("job.failed", { jobId: "j1", kind: "goal_propose", lineId: "r", rootLineId: "r", error: { code: "timed_out", message: "late" } }, "r", "r"));
    expect(target.live.getState().failedJobs.j1).toMatchObject({ kind: "goal_propose", error: { code: "timed_out" } });
  });
});

describe("applyEvent: B10 phase A (F6 phase 1)", () => {
  it("a tag-only update of a finished reply changes the cached message and the outline's anchorTag, and nothing about the turn", async () => {
    const tag = { kind: "idea", source: "ai", status: "draft", updatedAt: "t" };
    target.queryClient.setQueryData<MessagePage>(keys.messages("l1"), { messages: [message("a", 1)] });
    target.queryClient.setQueryData(keys.branches("r", true), { rootLineId: "r", branches: [{ lineId: "b", anchorMessageId: "a" }, { lineId: "c", anchorMessageId: "z" }] });
    target.queryClient.setQueryData(keys.preview("l1", ""), {});
    target.live.finishTurn("l1", "other");
    const before = target.live.getState();
    applyEvent(target, event("message.updated", message("a", 1, { tag }), "l1", "r"));
    await tick();
    expect(target.queryClient.getQueryData<MessagePage>(keys.messages("l1"))?.messages[0]?.tag).toMatchObject({ kind: "idea" });
    const outline = target.queryClient.getQueryData<{ branches: Array<{ lineId: string; anchorTag?: unknown }> }>(keys.branches("r", true))!;
    expect(outline.branches.map((branch) => [branch.lineId, branch.anchorTag ?? null])).toEqual([
      ["b", tag],
      ["c", null],
    ]);
    expect(target.queryClient.getQueryState(keys.preview("l1", ""))?.isInvalidated).toBe(false);
    expect(target.live.getState()).toBe(before);
    applyEvent(target, event("message.updated", message("a", 1), "l1", "r"));
    expect("anchorTag" in target.queryClient.getQueryData<{ branches: Array<Record<string, unknown>> }>(keys.branches("r", true))!.branches[0]!).toBe(false);
  });

  it("fold.changed reloads the line's folds and its previews (an active fold changes the prompt)", () => {
    for (const key of [keys.folds("l1"), keys.preview("l1", "")]) target.queryClient.setQueryData(key, {});
    applyEvent(target, event("fold.changed", { lineId: "l1", rootLineId: "r", fold: { id: "f", status: "active" } }, "l1", "r"));
    expect([keys.folds("l1"), keys.preview("l1", "")].map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true]);
  });
});

describe("applyEvent: B10 phase B (F6 phase 2)", () => {
  it("comparison.changed reloads the parent line's comparisons", () => {
    target.queryClient.setQueryData(keys.comparisons("p"), {});
    applyEvent(target, event("comparison.changed", { rootLineId: "r", comparison: { id: "c", parentLineId: "p", status: "ready" } }, "p", "r"));
    expect(target.queryClient.getQueryState(keys.comparisons("p"))?.isInvalidated).toBe(true);
  });
});

describe("applyEvent: the glossary (B24, F19)", () => {
  it("terms.changed reloads that tree's terms, the searches across conversations and the previews; another tree's terms stay", () => {
    // Arrange
    const loaded = [keys.terms("r"), keys.termSearch("mvcc"), keys.preview("l1", ""), keys.terms("other")];
    for (const key of loaded) target.queryClient.setQueryData(key, {});

    // Act: the term's source line is gone, so the envelope names only the tree.
    applyEvent(target, event("terms.changed", { rootLineId: "r", termId: "t1", change: "created" }, "", "r"));

    // Assert
    expect(loaded.map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, true, false]);
  });
});

describe("applyEvent: B10 phase C (F6 phase 3)", () => {
  it("memory.changed reloads the memories, their searches and the previews (each turn recalls them)", () => {
    for (const key of [keys.memories(), keys.memorySearch("q"), keys.preview("l1", "")]) target.queryClient.setQueryData(key, {});
    applyEvent(target, event("memory.changed", { memory: { id: "m" }, superseded: [] }, "", ""));
    expect([keys.memories(), keys.memorySearch("q"), keys.preview("l1", "")].map((key) => target.queryClient.getQueryState(key)?.isInvalidated)).toEqual([true, true, true]);
  });
});

