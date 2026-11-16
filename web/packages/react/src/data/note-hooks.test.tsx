import { TangentError, type NotesView } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { useNotes } from "./branch-queries";
import { useTangentEvents } from "./live-hooks";
import { useCreateNote, useSupersedeNote, useUpdateNote } from "./note-mutations";
import { createMemoryNotesSeen, useNotesBlock, useNotesSeen } from "./note-reads";
import { usePreview, useSearch } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient();
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

const statusOf = (view: NotesView | undefined, id: string) => view?.notes.find((note) => note.id === id)?.status;

describe("note writes", () => {
  it("adds a note: it is in the cache when the write resolves", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ notes: useNotes(NAS_ROOT_ID), create: useCreateNote("nas-b3") }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.notes.isSuccess).toBe(true));
    let id = "";
    await act(async () => {
      id = (await result.current.create.mutateAsync({ section: "todo", text: "Buy a UPS" })).note.id;
    });
    // TanStack notifies observers on its own tick; the cache already holds it.
    await waitFor(() => expect(result.current.notes.data?.notes.some((note) => note.id === id)).toBe(true));
  });

  it("marks a note done at once and keeps it when the server agrees", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ notes: useNotes(NAS_ROOT_ID), update: useUpdateNote(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.notes.isSuccess).toBe(true));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.update.mutateAsync({ noteId: "n6", input: { status: "done" } });
    });
    await waitFor(() => expect(statusOf(result.current.notes.data, "n6")).toBe("done"));
    await act(async () => {
      await done;
    });
    expect(statusOf(result.current.notes.data, "n6")).toBe("done");
  });

  it("rolls an edit back when the server refuses it", async () => {
    const client = tracked();
    vi.spyOn(client, "updateNote").mockRejectedValue(new TangentError(409, "superseded", "note_superseded"));
    const { result } = renderHook(() => ({ notes: useNotes(NAS_ROOT_ID), update: useUpdateNote(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.notes.isSuccess).toBe(true));
    await act(async () => {
      await result.current.update.mutateAsync({ noteId: "n2", input: { text: "預算上限 4 萬" } }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.update.error).toBeInstanceOf(TangentError));
    expect(result.current.notes.data?.notes.find((note) => note.id === "n2")?.text).toBe("預算上限 3 萬");
  });

  it("replaces a note: the old one is superseded and points to the new one", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ notes: useNotes(NAS_ROOT_ID), supersede: useSupersedeNote(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.notes.isSuccess).toBe(true));
    let id = "";
    await act(async () => {
      id = (await result.current.supersede.mutateAsync({ noteId: "n2", input: { text: "預算上限 3.5 萬" } })).note.id;
    });
    await waitFor(() => expect(result.current.notes.data?.notes.find((note) => note.id === "n2")).toMatchObject({ status: "superseded", supersededBy: id }));
    expect(result.current.notes.data?.notes.find((note) => note.id === id)?.text).toBe("預算上限 3.5 萬");
  });
});

describe("note writes keep the list's order (R5)", () => {
  /** Every order of note ids the cached page went through. */
  function recordOrders(queryClient: ReturnType<typeof testQueryClient>): string[][] {
    const orders: string[][] = [];
    queryClient.getQueryCache().subscribe((event) => {
      const view = event.query.state.data as NotesView | undefined;
      if (event.type === "updated" && view?.notes) orders.push(view.notes.map((note) => note.id));
    });
    return orders;
  }

  it("edits the third note in place: it never jumps to the top", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ notes: useNotes(NAS_ROOT_ID), update: useUpdateNote(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.notes.isSuccess).toBe(true));
    const before = result.current.notes.data!.notes.map((note) => note.id);
    const third = before[2]!;
    const orders = recordOrders(queryClient);
    await act(async () => {
      await result.current.update.mutateAsync({ noteId: third, input: { text: "edited" } });
    });
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) expect(order).toEqual(before);
    await waitFor(() => expect(result.current.notes.data?.notes.find((note) => note.id === third)?.text).toBe("edited"));
  });

  it("replaces in place: the new note goes first, the replaced one keeps its place", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ notes: useNotes(NAS_ROOT_ID), supersede: useSupersedeNote(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.notes.isSuccess).toBe(true));
    const before = result.current.notes.data!.notes.map((note) => note.id);
    const third = before[2]!;
    const orders = recordOrders(queryClient);
    let id = "";
    await act(async () => {
      id = (await result.current.supersede.mutateAsync({ noteId: third, input: { text: "replacement" } })).note.id;
    });
    // The first update is the write's own result, before the refetch.
    expect(orders[0]).toEqual([id, ...before]);
  });
});

describe("notes in the prompt", () => {
  it("reads the notes block of the next turn and refreshes it on notes.changed", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(
      () => {
        useTangentEvents();
        return { block: useNotesBlock(NAS_ROOT_ID), create: useCreateNote(NAS_ROOT_ID), draftPreview: usePreview(NAS_ROOT_ID, "hi") };
      },
      { wrapper: tangentWrapper(client, queryClient) },
    );
    await waitFor(() => expect(result.current.block.data?.content).toContain("檔案系統用 ZFS mirror"));
    expect(result.current.block.data?.tokens).toBeGreaterThan(0);
    await act(async () => {
      await result.current.create.mutateAsync({ section: "fact", text: "UPS 600VA" });
    });
    await waitFor(() => expect(result.current.block.data?.content).toContain("UPS 600VA"));
  });

  it("is off when disabled", () => {
    const client = tracked();
    const spy = vi.spyOn(client, "previewTurn");
    renderHook(() => useNotesBlock(NAS_ROOT_ID, false), { wrapper: tangentWrapper(client) });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useNotesSeen", () => {
  it("returns the previous visit for this whole visit and records the new one", () => {
    const store = createMemoryNotesSeen({ "": { nas: "2026-10-01T00:00:00.000Z" } });
    const now = vi.fn(() => "2026-10-16T00:00:00.000Z");
    const client = tracked();
    const { result, rerender } = renderHook(() => useNotesSeen(NAS_ROOT_ID, { store, now }), { wrapper: tangentWrapper(client) });
    expect(result.current).toBe("2026-10-01T00:00:00.000Z");
    rerender();
    expect(result.current).toBe("2026-10-01T00:00:00.000Z");
    expect(store.get("", NAS_ROOT_ID)).toBe("2026-10-16T00:00:00.000Z");
  });

  it("starts with no previous visit", () => {
    const store = createMemoryNotesSeen();
    const client = tracked();
    const { result } = renderHook(() => useNotesSeen("other", { store, now: () => "2026-10-16T00:00:00.000Z" }), { wrapper: tangentWrapper(client) });
    expect(result.current).toBeNull();
  });
});

describe("useSearch (B5 GET /search)", () => {
  it("asks the server once a query is given, and not while disabled", async () => {
    const client = tracked();
    const spy = vi.spyOn(client, "search");
    const { result, rerender } = renderHook(({ q, on }) => useSearch(q, on), { wrapper: tangentWrapper(client), initialProps: { q: "zfs", on: false } });
    expect(spy).not.toHaveBeenCalled();
    rerender({ q: "zfs", on: true });
    await waitFor(() => expect(result.current.data?.hits.length).toBeGreaterThan(0));
    expect(spy).toHaveBeenCalledWith({ q: "zfs", limit: 30 }, expect.anything());
  });
});

describe("useSearch: archived", () => {
  it("asks for the archived conversations only when told to", async () => {
    const client = tracked();
    const spy = vi.spyOn(client, "search");
    const { result } = renderHook(() => useSearch("osaka", true, true), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith({ q: "osaka", limit: 30, archived: true }, expect.anything());
  });
});
