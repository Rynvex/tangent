import { describe, expect, it } from "vitest";
import { createTangentClient } from "./api";
import { parseEvent } from "./events";
import { normalizeLine, normalizeMessage } from "./line-normalize";
import { DEFAULT_RELATION_LIMITS, normalizeGoalResult, normalizeOpenLoops, normalizeRelationList, normalizeRelationWrite } from "./p2-routes";

describe("B9 fields on existing shapes", () => {
  it("reads Message.pinned (false when absent) and LineView.staleBranches (0 when absent)", () => {
    expect(normalizeMessage({ id: "m" }).pinned).toBe(false);
    expect(normalizeMessage({ id: "m", pinned: true }).pinned).toBe(true);
    expect(normalizeLine({ id: "l" }).staleBranches).toBe(0);
    expect(normalizeLine({ id: "l", staleBranches: 2 }).staleBranches).toBe(2);
  });
});

describe("goal", () => {
  it("reads {goal: null} and a goal with defaults", () => {
    expect(normalizeGoalResult({ goal: null })).toEqual({ goal: null });
    expect(normalizeGoalResult({})).toEqual({ goal: null });
    expect(normalizeGoalResult({ goal: { text: "Plan", source: "weird" } }).goal).toEqual({
      rootLineId: "",
      text: "Plan",
      source: "manual",
      updatedBy: "",
      createdAt: "",
      updatedAt: "",
    });
    expect(normalizeGoalResult({ goal: { text: "Plan", source: "ai" } }).goal?.source).toBe("ai");
  });
});

describe("relations", () => {
  it("fills the limits and the links", () => {
    expect(normalizeRelationList({ relations: null })).toEqual({ relations: [], limits: DEFAULT_RELATION_LIMITS });
    const list = normalizeRelationList({ relations: [{ id: "r", kind: "relation", label: "x" }], limits: { maxPerTree: 5, labelMaxRunes: 50 } });
    expect(list.limits).toEqual({ maxPerTree: 5, labelMaxRunes: 50 });
    expect(list.relations[0]).toMatchObject({ id: "r", kind: "relation", label: "x", toMessageId: "" });
  });

  it("reads a created relation and the trees it touches", () => {
    expect(normalizeRelationWrite({ relation: { id: "r", kind: "relation" }, rootLineIds: ["a", 3, "b"] })).toMatchObject({ relation: { id: "r" }, rootLineIds: ["a", "b"] });
  });
});

describe("open loops", () => {
  it("keeps stale branches always and the other groups only when sent", () => {
    const loops = normalizeOpenLoops({ rootLineId: "", staleDays: 3, staleBranches: { items: [{ lineId: "b", rootTitle: "T" }], total: 1 } });
    expect(loops.staleBranches.total).toBe(1);
    expect(loops.staleBranches.items[0]).toMatchObject({ lineId: "b", rootTitle: "T", status: "open" });
    expect("toConfirm" in loops).toBe(false);
    expect("seeds" in loops).toBe(false);
    expect("suggestions" in loops).toBe(false);
    const all = normalizeOpenLoops({
      staleBranches: null,
      toConfirm: { items: [{ id: "n", rootLineId: "r", rootTitle: "T", text: "x" }], total: 3 },
      seeds: { items: [], total: 0 },
      suggestions: { items: [{ id: "s", rootTitle: "T", payload: {} }], total: 1 },
    });
    expect(all.staleBranches).toEqual({ items: [], total: 0 });
    expect(all.toConfirm?.items[0]).toMatchObject({ id: "n", rootLineId: "r", rootTitle: "T" });
    expect(all.toConfirm?.total).toBe(3);
    expect(all.seeds).toEqual({ items: [], total: 0 });
    expect(all.suggestions?.items[0]).toMatchObject({ id: "s", rootTitle: "T" });
  });
});

describe("routes", () => {
  function recorder() {
    const sent: Array<{ method: string; url: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(init?.method === "DELETE" ? null : "{}", { status: init?.method === "DELETE" ? 204 : 200, headers: { "Content-Type": "application/json" } });
    };
    return { client: createTangentClient({ baseUrl: "/api", fetch }), sent };
  }

  it("send the right method, path, query and body", async () => {
    const { client, sent } = recorder();
    await client.getGoal("l1");
    await client.putGoal("l1", { text: "Plan" });
    await client.deleteGoal("l1");
    await client.proposeGoal("l1");
    await client.listRelations("l1");
    await client.createRelation("l1", { toLineId: "l2", label: "x" });
    await client.deleteRelation("l1", "r1");
    await client.listOpenLoops();
    await client.listOpenLoops({ root: "l1", staleDays: 4 });
    await client.pinMessage("m1");
    await client.unpinMessage("m1");
    expect(sent).toEqual([
      { method: "GET", url: "/api/lines/l1/goal", body: undefined },
      { method: "PUT", url: "/api/lines/l1/goal", body: { text: "Plan" } },
      { method: "DELETE", url: "/api/lines/l1/goal", body: undefined },
      { method: "POST", url: "/api/lines/l1/goal/propose", body: undefined },
      { method: "GET", url: "/api/lines/l1/relations", body: undefined },
      { method: "POST", url: "/api/lines/l1/relations", body: { toLineId: "l2", label: "x" } },
      { method: "DELETE", url: "/api/lines/l1/relations/r1", body: undefined },
      { method: "GET", url: "/api/open-loops", body: undefined },
      { method: "GET", url: "/api/open-loops?root=l1&staleDays=4", body: undefined },
      { method: "POST", url: "/api/messages/m1/pin", body: undefined },
      { method: "DELETE", url: "/api/messages/m1/pin", body: undefined },
    ]);
  });
});

describe("B9 events", () => {
  const envelope = (type: string, data: unknown) => JSON.stringify({ type, tenant: "", rootLineId: "r", lineId: "r", data });

  it("goal.changed carries the goal or null", () => {
    expect(parseEvent("goal.changed", envelope("goal.changed", { rootLineId: "r", goal: null })).data).toEqual({ rootLineId: "r", goal: null });
    const set = parseEvent("goal.changed", envelope("goal.changed", { rootLineId: "r", goal: { text: "Plan", source: "ai" } }));
    expect(set.data).toMatchObject({ rootLineId: "r", goal: { text: "Plan", source: "ai" } });
  });

  it("link.changed marks a deleted link only when the server says so", () => {
    const made = parseEvent("link.changed", envelope("link.changed", { rootLineId: "r", link: { id: "x", kind: "relation" } }));
    expect("deleted" in made.data).toBe(false);
    const gone = parseEvent("link.changed", envelope("link.changed", { rootLineId: "r", link: { id: "x", kind: "relation" }, deleted: true }));
    expect(gone.data).toMatchObject({ deleted: true });
  });
});
