import { type BranchList, type BranchView, type MessagePage, type TangentEvent } from "@tangent/client";
import { NAS_ROOT_ID, type MockTangentClient } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangent } from "../provider";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { useContinueAside, useDeleteBranch, useKeepBranch } from "./aside-hooks";
import { applyEvent } from "./event-sync";
import { useTangentEvents } from "./live-hooks";
import { useBranchDetail } from "./branch-queries";
import { useBranches, useMessages } from "./queries";

/** B23 / F18: keeping, continuing and deleting leave the cache as their events would, whichever comes first. */

const clients: MockTangentClient[] = [];
function tracked() {
  const client = mockClient();
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

/** An answered aside on the main line. */
async function answeredAside(client: MockTangentClient, purpose = "What is a scrub?") {
  const made = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "aside" });
  await client.sendMessage(made.line.id, { content: purpose });
  await waitFor(async () => expect((await client.getBranch(made.line.id)).branch.status).toBe("discarded"));
  return made.line.id;
}

function useScreen(asideId: string, events: boolean) {
  useTangentEvents({ enabled: events });
  const outline = useBranches(NAS_ROOT_ID, true);
  // Read while rendering, as a component would: TanStack Query re-renders only for the fields a render used.
  void outline.data;
  return {
    ctx: useTangent(),
    outline,
    plain: useBranches(NAS_ROOT_ID),
    detail: useBranchDetail(asideId),
    messages: useMessages(asideId),
    keep: useKeepBranch(),
    continueAside: useContinueAside(),
    remove: useDeleteBranch(),
  };
}

async function renderScreen(events = false) {
  const client = tracked();
  const asideId = await answeredAside(client);
  const queryClient = testQueryClient();
  const view = renderHook(() => useScreen(asideId, events), { wrapper: tangentWrapper(client, queryClient) });
  await waitFor(() => expect(view.result.current.outline.isSuccess && view.result.current.plain.isSuccess && view.result.current.detail.isSuccess && view.result.current.messages.isSuccess).toBe(true));
  return { client, queryClient, view, asideId };
}

const inOutline = (list: BranchList | undefined, lineId: string) => list?.branches.find((branch) => branch.lineId === lineId);

describe("useKeepBranch", () => {
  it("writes keptAt into the outline and the detail in place, with no list read again", async () => {
    const { client, view, asideId } = await renderScreen();
    const listBranches = vi.spyOn(client, "listBranches");
    const getBranch = vi.spyOn(client, "getBranch");
    await act(async () => {
      await view.result.current.keep.mutateAsync({ lineId: asideId, keep: true });
    });
    await waitFor(() => expect(inOutline(view.result.current.outline.data, asideId)?.keptAt).toEqual(expect.any(String)));
    expect(view.result.current.detail.data?.branch.keptAt).toEqual(expect.any(String));
    await act(async () => {
      await view.result.current.keep.mutateAsync({ lineId: asideId, keep: false });
    });
    await waitFor(() => expect("keptAt" in inOutline(view.result.current.outline.data, asideId)!).toBe(false));
    expect(listBranches).not.toHaveBeenCalled();
    expect(getBranch).not.toHaveBeenCalled();
  });

  it("branch.changed{kept} from elsewhere reads the outline and the branch again, and nothing of its lines", async () => {
    const { queryClient, view, asideId } = await renderScreen();
    const { keys, live } = view.result.current.ctx;
    queryClient.setQueryData(keys.lineView(asideId), { id: asideId });
    queryClient.setQueryData(keys.lineView(NAS_ROOT_ID), { id: NAS_ROOT_ID });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const branch: BranchView = { ...inOutline(view.result.current.outline.data, asideId)!, keptAt: "2026-11-13T00:00:00Z" };
    act(() => applyEvent({ queryClient, keys, live }, { type: "branch.changed", tenant: "", lineId: asideId, rootLineId: NAS_ROOT_ID, data: { change: "kept", branch } } as TangentEvent));
    const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(asked).toContain(JSON.stringify(keys.branchesOf(NAS_ROOT_ID)));
    expect(asked).toContain(JSON.stringify(keys.branch(asideId)));
    expect(asked).not.toContain(JSON.stringify(keys.lineView(asideId)));
    expect(asked).not.toContain(JSON.stringify(keys.lineView(NAS_ROOT_ID)));
    expect(asked).not.toContain(JSON.stringify(keys.messages(asideId)));
  });
});

describe("useDeleteBranch", () => {
  it("drops the branch from both outlines and its own queries; the tree's other lines stay cached", async () => {
    const { queryClient, view, asideId } = await renderScreen();
    const { keys } = view.result.current.ctx;
    queryClient.setQueryData(keys.lineView("nas-b3"), { id: "nas-b3" });
    await act(async () => {
      await view.result.current.remove.mutateAsync({ lineId: asideId });
    });
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true)), asideId)).toBeUndefined();
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true)), "nas-b3")).toBeDefined();
    expect(queryClient.getQueryData(keys.lineView("nas-b3"))).toEqual({ id: "nas-b3" });
    expect(queryClient.getQueryCache().findAll({ queryKey: keys.line(NAS_ROOT_ID) }).length).toBeGreaterThan(0);
  });

  it("line.deleted for some lines of a tree (the root stays) removes just those, once", async () => {
    const { queryClient, view } = await renderScreen();
    const { keys, live } = view.result.current.ctx;
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const event = { type: "line.deleted", tenant: "", lineId: "nas-b4", rootLineId: NAS_ROOT_ID, data: { rootLineId: NAS_ROOT_ID, lineIds: ["nas-b4"] } } as TangentEvent;
    act(() => applyEvent({ queryClient, keys, live }, event));
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true)), "nas-b4")).toBeUndefined();
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID)), "nas-b4")).toBeUndefined();
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true)), "nas-b5")).toBeDefined();
    const calls = invalidate.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    act(() => applyEvent({ queryClient, keys, live }, event));
    expect(invalidate.mock.calls.length).toBe(calls);
  });

  it("a branch combined into a deleted one comes back without its mergedIntoLineId once the outline is read again", async () => {
    const { client, view } = await renderScreen();
    const a = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router A", kind: "investigate" });
    const b = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router B", kind: "investigate" });
    const target = (await client.combineBranches(NAS_ROOT_ID, { lineIds: [a.line.id, b.line.id], purpose: "Pick the router" })).branch.lineId;
    await client.discardBranch(target);
    await act(async () => {
      await view.result.current.outline.refetch();
    });
    await waitFor(() => expect(inOutline(view.result.current.outline.data, a.line.id)?.mergedIntoLineId).toBe(target));
    await act(async () => {
      await view.result.current.remove.mutateAsync({ lineId: target });
    });
    await waitFor(() => expect(inOutline(view.result.current.outline.data, a.line.id)?.mergedIntoLineId).toBe(""));
    expect(inOutline(view.result.current.outline.data, target)).toBeUndefined();
  });
});

describe("useContinueAside", () => {
  it("shows the aside's question and answer on the new line at once, and the aside leaves the outline", async () => {
    const { queryClient, view, asideId } = await renderScreen();
    const { keys } = view.result.current.ctx;
    const before = view.result.current.messages.data!.messages;
    let newLineId = "";
    await act(async () => {
      newLineId = (await view.result.current.continueAside.mutateAsync({ lineId: asideId })).line.id;
    });
    const seeded = queryClient.getQueryData<MessagePage>(keys.messages(newLineId));
    expect(seeded?.messages.map((message) => [message.id, message.lineId])).toEqual(before.map((message) => [message.id, newLineId]));
    expect(queryClient.getQueryData(keys.lineView(newLineId))).toMatchObject({ id: newLineId });
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true)), asideId)).toBeUndefined();
    await waitFor(() => expect(inOutline(view.result.current.outline.data, newLineId)).toMatchObject({ status: "open", kind: "investigate" }));
  });

  it("works the same when the aside's line.deleted arrives before the result (events on)", async () => {
    const { queryClient, view, asideId } = await renderScreen(true);
    const { keys } = view.result.current.ctx;
    let newLineId = "";
    await act(async () => {
      newLineId = (await view.result.current.continueAside.mutateAsync({ lineId: asideId })).line.id;
    });
    expect(queryClient.getQueryData<MessagePage>(keys.messages(newLineId))?.messages).toHaveLength(2);
    await waitFor(() => expect(inOutline(view.result.current.outline.data, newLineId)).toBeDefined());
    expect(inOutline(view.result.current.outline.data, asideId)).toBeUndefined();
  });
});

describe("hidden branches (a delete asked for, not sent yet)", () => {
  it("leaves them out of the outline until shown again; the cached list is untouched", async () => {
    const { queryClient, view, asideId } = await renderScreen();
    const { keys, live } = view.result.current.ctx;
    act(() => live.setHidden([asideId], true));
    expect(inOutline(view.result.current.outline.data, asideId)).toBeUndefined();
    expect(inOutline(queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true)), asideId)).toBeDefined();
    act(() => live.setHidden([asideId], false));
    expect(inOutline(view.result.current.outline.data, asideId)).toBeDefined();
  });

  it("hiding twice and showing once shows it; a mark on a line deleted since changes nothing", async () => {
    const { view, asideId } = await renderScreen();
    const { live } = view.result.current.ctx;
    act(() => live.setHidden([asideId], true));
    act(() => live.setHidden([asideId], true));
    act(() => live.setHidden([asideId], false));
    expect(inOutline(view.result.current.outline.data, asideId)).toBeDefined();
    act(() => live.setHidden(["nas-b4"], true));
    await act(async () => {
      await view.result.current.remove.mutateAsync({ lineId: "nas-b4" });
    });
    expect(inOutline(view.result.current.outline.data, "nas-b4")).toBeUndefined();
    expect(inOutline(view.result.current.outline.data, "nas-b5")).toBeDefined();
  });
});
