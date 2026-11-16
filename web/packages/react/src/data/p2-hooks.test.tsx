import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { useAcceptSuggestion, useSuggestions } from "./p1-hooks";
import { useCombineBranches, useCreateGroup, useDissolveGroup, useGroups, useRenameGroup } from "./group-hooks";
import { useCreateRelation, useDeleteGoal, useDeleteRelation, useGoal, useOpenLoops, useProposeGoal, usePutGoal, useRelations, useUpdateRelation } from "./p2-hooks";
import { usePinMessage } from "./pin-hooks";
import { useBranches, useLine, useMessages } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient({ draftMs: 5 });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

describe("goal hooks (C4)", () => {
  it("reads the goal of the tree from any of its lines, writes and clears it in place", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ goal: useGoal(NAS_ROOT_ID), put: usePutGoal(NAS_ROOT_ID), clear: useDeleteGoal(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.goal.data?.goal?.source).toBe("manual"));
    await act(async () => {
      await result.current.put.mutateAsync({ text: "Keep the photos safe" });
    });
    await waitFor(() => expect(result.current.goal.data?.goal?.text).toBe("Keep the photos safe"));
    await act(async () => {
      await result.current.clear.mutateAsync();
    });
    await waitFor(() => expect(result.current.goal.data?.goal).toBeNull());
  });

  it("a proposal arrives in the inbox; accepting it writes the goal at once", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(
      () => ({ goal: useGoal(NAS_ROOT_ID), clear: useDeleteGoal(NAS_ROOT_ID), propose: useProposeGoal(NAS_ROOT_ID), inbox: useSuggestions(NAS_ROOT_ID), accept: useAcceptSuggestion(NAS_ROOT_ID) }),
      { wrapper: tangentWrapper(client, queryClient) },
    );
    await waitFor(() => expect(result.current.goal.isSuccess).toBe(true));
    await act(async () => {
      await result.current.clear.mutateAsync();
      await result.current.propose.mutateAsync();
    });
    // In the app, suggestion.changed reloads the inbox (event-sync); here the test does.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await queryClient.invalidateQueries({ queryKey: ["tangent", "mock:", "", "", "line", NAS_ROOT_ID, "suggestions"] });
    });
    await waitFor(() => expect(result.current.inbox.data?.suggestions.some((item) => item.kind === "goal_propose")).toBe(true));
    const proposal = result.current.inbox.data?.suggestions.find((item) => item.kind === "goal_propose");
    await act(async () => {
      await result.current.accept.mutateAsync({ suggestionId: proposal!.id });
    });
    await waitFor(() => expect(result.current.goal.data?.goal?.source).toBe("ai"));
  });
});

describe("relation hooks (C3)", () => {
  it("creates and deletes a relation; the list follows", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ list: useRelations(NAS_ROOT_ID), create: useCreateRelation(NAS_ROOT_ID), remove: useDeleteRelation(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const made = await act(async () => result.current.create.mutateAsync({ fromLineId: "nas-b3", toLineId: "nas-b2", label: "Same budget" }));
    await waitFor(() => expect(result.current.list.data?.relations.map((item) => item.id)).toEqual([made.relation.id]));
    await act(async () => {
      await result.current.remove.mutateAsync({ relationId: made.relation.id });
    });
    await waitFor(() => expect(result.current.list.data?.relations).toEqual([]));
  });

  it("accepting a drift hint opens its branch: the outline and the new line are there at once", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    await client.sendMessage(NAS_ROOT_ID, { content: "[fake:drift] remote access?" });
    for (let i = 0; i < 300 && (await client.getLine(NAS_ROOT_ID)).status === "thinking"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const drift = (await client.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.kind === "drift")!;
    const { result } = renderHook(() => ({ outline: useBranches(NAS_ROOT_ID, true), accept: useAcceptSuggestion(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.outline.isSuccess).toBe(true));
    const written = await act(async () => result.current.accept.mutateAsync({ suggestionId: drift.id }));
    const branch = (written.result as { branch: { lineId: string } }).branch;
    await waitFor(() => expect(result.current.outline.data?.branches.some((item) => item.lineId === branch.lineId)).toBe(true));
    expect(queryClient.getQueryData(["tangent", "mock:", "", "", "line", branch.lineId, "view"])).toBeDefined();
  });
});

describe("open loops (C5)", () => {
  it("reads one conversation or all of them", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ one: useOpenLoops(NAS_ROOT_ID), all: useOpenLoops(null) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.one.isSuccess && result.current.all.isSuccess).toBe(true));
    expect(result.current.one.data?.rootLineId).toBe(NAS_ROOT_ID);
    expect(result.current.all.data?.rootLineId).toBe("");
    expect(result.current.one.data?.staleBranches.total).toBe(1);
  });
});

describe("pins", () => {
  it("pins a message; the transcript shows it without a refetch", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ messages: useMessages(NAS_ROOT_ID), pin: usePinMessage(), line: useLine(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    await act(async () => {
      await result.current.pin.mutateAsync({ messageId: "nas-m17", pinned: true });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.find((message) => message.id === "nas-m17")?.pinned).toBe(true));
    await act(async () => {
      await result.current.pin.mutateAsync({ messageId: "nas-m17", pinned: false });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.find((message) => message.id === "nas-m17")?.pinned).toBe(false));
  });
});

describe("group hooks (C2)", () => {
  it("creates a group of ended branches, renames and dissolves it; the list follows", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => ({ list: useGroups(NAS_ROOT_ID), create: useCreateGroup(NAS_ROOT_ID), rename: useRenameGroup(NAS_ROOT_ID), dissolve: useDissolveGroup(NAS_ROOT_ID) }),
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    const made = await act(async () => result.current.create.mutateAsync({ memberLineIds: ["nas-b4", "nas-b5"], title: "Hardware" }));
    await waitFor(() => expect(result.current.list.data?.groups.map((group) => group.id)).toEqual([made.group.id]));
    await act(async () => {
      await result.current.rename.mutateAsync({ groupId: made.group.id, title: "Disks" });
    });
    await waitFor(() => expect(result.current.list.data?.groups[0]?.title).toBe("Disks"));
    await act(async () => {
      await result.current.dissolve.mutateAsync({ groupId: made.group.id });
    });
    await waitFor(() => expect(result.current.list.data?.groups).toEqual([]));
  });

  it("combines open siblings: the outline shows the new branch and the old ones ended into it", async () => {
    const client = tracked();
    const a = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "A", kind: "investigate" });
    const b = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "B", kind: "investigate" });
    const { result } = renderHook(() => ({ outline: useBranches(NAS_ROOT_ID, true), combine: useCombineBranches(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.outline.isSuccess).toBe(true));
    const done = await act(async () => result.current.combine.mutateAsync({ parentLineId: NAS_ROOT_ID, input: { lineIds: [a.line.id, b.line.id], purpose: "Both" } }));
    await waitFor(() => expect(result.current.outline.data?.branches.find((branch) => branch.lineId === a.line.id)?.mergedIntoLineId).toBe(done.line.id));
  });

  it("changes a relation's label", async () => {
    const client = tracked();
    const made = await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3" });
    const { result } = renderHook(() => ({ list: useRelations(NAS_ROOT_ID), update: useUpdateRelation(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await act(async () => {
      await result.current.update.mutateAsync({ relationId: made.relation.id, label: "same budget" });
    });
    await waitFor(() => expect(result.current.list.data?.relations[0]?.label).toBe("same budget"));
  });
});
