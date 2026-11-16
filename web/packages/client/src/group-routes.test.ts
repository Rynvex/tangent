import { describe, expect, it } from "vitest";
import { createTangentClient } from "./api";
import { normalizeBranchView } from "./branch-normalize";
import { parseEvent } from "./events";
import { DEFAULT_GROUP_LIMITS, normalizeCombineResult, normalizeGroup, normalizeGroupList, normalizeGroupWrite } from "./group-routes";

describe("B9 phase C shapes", () => {
  it("BranchView gets mergedIntoLineId ('' when absent) and the merge origin", () => {
    expect(normalizeBranchView({ lineId: "b" }).mergedIntoLineId).toBe("");
    expect(normalizeBranchView({ lineId: "b", mergedIntoLineId: "n", origin: "merge" })).toMatchObject({ mergedIntoLineId: "n", origin: "merge" });
  });

  it("reads a group with its defaults", () => {
    expect(normalizeGroup({ id: "g", memberLineIds: ["a", 1, "b"], summaryStatus: "weird", status: "weird" })).toEqual({
      id: "g",
      rootLineId: "",
      title: "",
      summary: "",
      summaryStatus: "none",
      status: "active",
      memberLineIds: ["a", "b"],
      createdBy: "",
      createdAt: "",
      updatedAt: "",
    });
  });

  it("fills the list's limits", () => {
    expect(normalizeGroupList({ groups: null })).toEqual({ rootLineId: "", groups: [], limits: DEFAULT_GROUP_LIMITS });
    expect(normalizeGroupList({ limits: { maxMembers: 3, maxActivePerTree: 4, titleMaxRunes: 5 } }).limits).toEqual({ maxMembers: 3, maxActivePerTree: 4, titleMaxRunes: 5 });
  });

  it("reads a created group: the summary job (or null) and the keepBoth notes when sent", () => {
    const written = normalizeGroupWrite({ group: { id: "g" }, job: null });
    expect(written.job).toBeNull();
    expect("notes" in written).toBe(false);
    const withJob = normalizeGroupWrite({ group: { id: "g" }, job: { jobId: "j", kind: "group_summary", lineId: "r" }, notes: { created: [{ id: "n" }], revision: 2, rootLineId: "r", superseded: [] } });
    expect(withJob.job).toMatchObject({ jobId: "j", kind: "group_summary" });
    expect(withJob.notes?.created[0]?.id).toBe("n");
  });

  it("reads a combine: the new branch (origin merge) and the branches it replaced", () => {
    const result = normalizeCombineResult({ line: { id: "n" }, branch: { lineId: "n", origin: "merge" }, pack: {}, combined: [{ lineId: "a", mergedIntoLineId: "n", status: "discarded" }] });
    expect(result.branch.origin).toBe("merge");
    expect(result.combined[0]).toMatchObject({ lineId: "a", mergedIntoLineId: "n", status: "discarded" });
    expect("notes" in result).toBe(false);
  });
});

describe("B9 phase C events", () => {
  const envelope = (type: string, data: unknown) => JSON.stringify({ type, tenant: "", rootLineId: "r", lineId: "r", data });

  it("group.changed carries the group", () => {
    expect(parseEvent("group.changed", envelope("group.changed", { rootLineId: "r", group: { id: "g", summaryStatus: "ready" } })).data).toMatchObject({ rootLineId: "r", group: { id: "g", summaryStatus: "ready" } });
  });

  it("job.failed carries the job and why", () => {
    const event = parseEvent("job.failed", envelope("job.failed", { jobId: "j", kind: "goal_propose", lineId: "r", rootLineId: "r", error: { code: "nope", message: "x" } }));
    expect(event.data).toEqual({ jobId: "j", kind: "goal_propose", lineId: "r", rootLineId: "r", error: { code: "failed", message: "x" } });
  });
});

describe("B9 phase C routes", () => {
  it("send the right method, path and body", async () => {
    const sent: Array<{ method: string; url: string; body: unknown }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const c = createTangentClient({ baseUrl: "/api", fetch });
    await c.listGroups("r");
    await c.listGroups("r", { status: "all" });
    await c.createGroup("r", { memberLineIds: ["a", "b"], title: "T" });
    await c.getGroup("g");
    await c.renameGroup("g", { title: "U" });
    await c.dissolveGroup("g");
    await c.summarizeGroup("g");
    await c.combineBranches("p", { lineIds: ["a", "b"], purpose: "P" });
    await c.updateRelation("r", "x", { label: "L" });
    expect(sent).toEqual([
      { method: "GET", url: "/api/lines/r/groups", body: undefined },
      { method: "GET", url: "/api/lines/r/groups?status=all", body: undefined },
      { method: "POST", url: "/api/lines/r/groups", body: { memberLineIds: ["a", "b"], title: "T" } },
      { method: "GET", url: "/api/groups/g", body: undefined },
      { method: "PATCH", url: "/api/groups/g", body: { title: "U" } },
      { method: "POST", url: "/api/groups/g/dissolve", body: undefined },
      { method: "POST", url: "/api/groups/g/summarize", body: undefined },
      { method: "POST", url: "/api/lines/p/branches/combine", body: { lineIds: ["a", "b"], purpose: "P" } },
      { method: "PATCH", url: "/api/lines/r/relations/x", body: { label: "L" } },
    ]);
  });
});
