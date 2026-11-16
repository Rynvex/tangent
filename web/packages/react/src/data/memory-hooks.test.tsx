import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { useCreateMemory, useMemories, useMemorySearch, useSupersedeMemory, useUpdateMemory } from "./memory-hooks";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient({ draftMs: 5 });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

describe("memory hooks (D1)", () => {
  it("writes, recategorizes and supersedes; the lists (active and history) and searches follow", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => ({
        active: useMemories({}),
        history: useMemories({ status: "superseded" }),
        search: useMemorySearch("Which ZFS layout for the NAS?"),
        create: useCreateMemory(),
        update: useUpdateMemory(),
        supersede: useSupersedeMemory(),
      }),
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.active.data?.memories).toEqual([]));
    let id = "";
    await act(async () => {
      id = (await result.current.create.mutateAsync({ kind: "decision", text: "The NAS uses a ZFS mirror" })).memory.id;
    });
    await waitFor(() => expect(result.current.active.data?.memories.map((memory) => memory.id)).toEqual([id]));
    await waitFor(() => expect(result.current.search.data?.results.map((item) => item.memory.id)).toEqual([id]));
    await act(async () => {
      await result.current.update.mutateAsync({ memoryId: id, input: { importance: 9 } });
    });
    await waitFor(() => expect(result.current.active.data?.memories[0]?.importance).toBe(9));
    await act(async () => {
      await result.current.supersede.mutateAsync({ memoryId: id, input: { text: "The NAS uses ZFS RAIDZ1" } });
    });
    await waitFor(() => expect(result.current.history.data?.memories.map((memory) => memory.id)).toEqual([id]));
    expect(result.current.active.data?.memories[0]?.text).toBe("The NAS uses ZFS RAIDZ1");
  });

  it("B10.1: loads a page at a time, appends the next and reloads every loaded page after a write", async () => {
    const client = tracked();
    const ids: string[] = [];
    for (const text of ["one", "two", "three"]) ids.unshift((await client.createMemory({ kind: "fact", text })).memory.id);
    const { result } = renderHook(() => ({ list: useMemories({ limit: 2 }), create: useCreateMemory() }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.list.data?.memories.map((memory) => memory.id)).toEqual(ids.slice(0, 2)));
    expect(result.current.list.hasNextPage).toBe(true);
    await act(async () => {
      await result.current.list.fetchNextPage();
    });
    await waitFor(() => expect(result.current.list.data?.memories.map((memory) => memory.id)).toEqual(ids));
    expect(result.current.list.hasNextPage).toBe(false);
    let added = "";
    await act(async () => {
      added = (await result.current.create.mutateAsync({ kind: "fact", text: "four" })).memory.id;
    });
    await waitFor(() => expect(result.current.list.data?.memories.map((memory) => memory.id)).toEqual([added, ...ids]));
    expect(result.current.list.hasNextPage).toBe(false);
  });

  it("does not search an empty query", () => {
    const client = tracked();
    const { result } = renderHook(() => useMemorySearch("  "), { wrapper: tangentWrapper(client) });
    expect(result.current.fetchStatus).toBe("idle");
  });
});
