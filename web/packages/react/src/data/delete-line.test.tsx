import { normalizeLine, type LinePage, type LineView, type TangentEvent } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangent } from "../provider";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { applyEvent } from "./event-sync";
import { useTangentEvents } from "./live-hooks";
import { useDeleteLine } from "./mutations";
import { useBranches, useLine, useLines, useMessages } from "./queries";

/** F7: `useDeleteLine` and `line.deleted` leave the cache the same way, whichever comes first, without doing it twice. */

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient();
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

const TREE = [NAS_ROOT_ID, "nas-b1", "nas-b1a", "nas-b2"];
const deletedEvent = (lineIds: readonly string[]) => ({ type: "line.deleted", tenant: "", lineId: lineIds[0], rootLineId: lineIds[0], data: { rootLineId: lineIds[0], lineIds } }) as TangentEvent;

/**
 * The conversation list and an open conversation, with or without the event
 * stream; like the demo, the screen leaves the conversation in the same
 * update that deletes it (`deleteOpen`), so nothing reads it again.
 */
function useScreen(events: boolean) {
  useTangentEvents({ enabled: events });
  const ctx = useTangent();
  const [open, setOpen] = useState<string | null>(NAS_ROOT_ID);
  const remove = useDeleteLine();
  return {
    ctx,
    lines: useLines(),
    line: useLine(open),
    messages: useMessages(open),
    branches: useBranches(open, true),
    remove,
    deleteOpen: () => remove.mutateAsync(NAS_ROOT_ID).then(() => setOpen(null)),
  };
}

async function renderScreen(events = false) {
  const client = tracked();
  const queryClient = testQueryClient();
  const view = renderHook(() => useScreen(events), { wrapper: tangentWrapper(client, queryClient) });
  await waitFor(() => expect(view.result.current.lines.isSuccess && view.result.current.messages.isSuccess && view.result.current.branches.isSuccess).toBe(true));
  return { client, queryClient, view };
}

const listed = (queryClient: ReturnType<typeof testQueryClient>, keys: ReturnType<typeof useTangent>["keys"]) =>
  queryClient.getQueryData<LinePage>(keys.lines())?.lines.map((line) => line.id);

describe("useDeleteLine (F7)", () => {
  it("removes every line of the tree from the cache and the list, without reading any of them again", async () => {
    const { client, queryClient, view } = await renderScreen();
    const { keys } = view.result.current.ctx;
    const getLine = vi.spyOn(client, "getLine");
    const listMessages = vi.spyOn(client, "listMessages");
    await act(() => view.result.current.deleteOpen());
    expect(listed(queryClient, keys)).not.toContain(NAS_ROOT_ID);
    for (const id of TREE) expect(queryClient.getQueryCache().findAll({ queryKey: keys.line(id) }), id).toEqual([]);
    expect(getLine).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
  });

  it("marks cross-conversation reads stale: open loops, search, other trees' links and a line spun off from it", async () => {
    const { queryClient, view } = await renderScreen();
    const { keys } = view.result.current.ctx;
    const spun = normalizeLine({ id: "spun", title: "spun", spunOffFrom: { lineId: NAS_ROOT_ID, messageId: "nas-m40", title: "NAS", available: true } });
    const other = normalizeLine({ id: "other", title: "other" });
    const stale = [keys.openLoops(null), keys.search("NAS"), keys.links("spun"), keys.relations("other"), keys.lineView("spun")];
    for (const key of [...stale, keys.lineView("other")]) queryClient.setQueryData(key, key.includes("view") ? (key.includes("spun") ? spun : other) : {});
    await act(() => view.result.current.deleteOpen());
    for (const key of stale) expect(queryClient.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    expect(queryClient.getQueryState(keys.lineView("other"))?.isInvalidated).toBe(false);
  });

  it("leaves the cache alone when the server refuses (a reply is running: session_busy)", async () => {
    const { client, queryClient, view } = await renderScreen();
    const { keys } = view.result.current.ctx;
    await client.sendMessage("nas-b2", { content: "[fake:slow] still thinking" });
    await act(() => view.result.current.deleteOpen().catch(() => undefined));
    await waitFor(() => expect(view.result.current.remove.error).toMatchObject({ code: "session_busy" }));
    expect(listed(queryClient, keys)).toContain(NAS_ROOT_ID);
    expect(queryClient.getQueryData<LineView>(keys.lineView(NAS_ROOT_ID))?.id).toBe(NAS_ROOT_ID);
  });

  it("does the work once: the line.deleted event after the delete's own result changes nothing", async () => {
    const { queryClient, view } = await renderScreen();
    const { keys, live } = view.result.current.ctx;
    await act(() => view.result.current.deleteOpen());
    queryClient.setQueryData(keys.openLoops(null), {});
    const before = listed(queryClient, keys);
    applyEvent({ queryClient, keys, live }, deletedEvent(TREE));
    expect(listed(queryClient, keys)).toEqual(before);
    expect(queryClient.getQueryState(keys.openLoops(null))?.isInvalidated).toBe(false);
  });

  it("does the work once the other way round: the event first, then the result", async () => {
    const { queryClient, view } = await renderScreen();
    const { keys, live } = view.result.current.ctx;
    // The server's event names the same lines as the delete's result: the whole tree.
    const tree = [NAS_ROOT_ID, ...(view.result.current.branches.data?.branches.map((branch) => branch.lineId) ?? [])];
    applyEvent({ queryClient, keys, live }, deletedEvent(tree));
    expect(listed(queryClient, keys)).not.toContain(NAS_ROOT_ID);
    queryClient.setQueryData(keys.openLoops(null), {});
    await act(() => view.result.current.deleteOpen().catch(() => undefined));
    expect(queryClient.getQueryState(keys.openLoops(null))?.isInvalidated).toBe(false);
  });

  it("with the event stream on, the list ends without the conversation and nothing refetches the deleted lines", async () => {
    const { client, queryClient, view } = await renderScreen(true);
    const { keys } = view.result.current.ctx;
    const getLine = vi.spyOn(client, "getLine");
    await act(() => view.result.current.deleteOpen());
    await waitFor(() => expect(listed(queryClient, keys)).not.toContain(NAS_ROOT_ID));
    expect(getLine).not.toHaveBeenCalled();
  });
});
