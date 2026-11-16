import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { useCreateFold, useDeleteFold, useFolds, useTagMessage } from "./p3-hooks";
import { useBranches, useMessages } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient({ draftMs: 5 });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

describe("argument tag hooks (D2)", () => {
  it("tags a message: the transcript and the outline's anchorTag show it at once, and clearing removes both", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ messages: useMessages(NAS_ROOT_ID), outline: useBranches(NAS_ROOT_ID, true), tag: useTagMessage(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.outline.data).toBeDefined());
    await waitFor(() => expect(result.current.messages.data).toBeDefined());
    await act(async () => {
      await result.current.tag.mutateAsync({ messageId: "nas-m17", kind: "decision" });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.find((message) => message.id === "nas-m17")?.tag?.kind).toBe("decision"));
    expect(result.current.outline.data?.branches.find((branch) => branch.anchorMessageId === "nas-m17")?.anchorTag?.kind).toBe("decision");
    await act(async () => {
      await result.current.tag.mutateAsync({ messageId: "nas-m17", kind: null });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.find((message) => message.id === "nas-m17")?.tag).toBeUndefined());
    expect(result.current.outline.data?.branches.find((branch) => branch.anchorMessageId === "nas-m17")?.anchorTag).toBeUndefined();
  });
});

describe("fold hooks (D4)", () => {
  it("creates and removes folds; the list follows", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ folds: useFolds(NAS_ROOT_ID), create: useCreateFold(NAS_ROOT_ID), remove: useDeleteFold(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.folds.data?.folds).toEqual([]));
    const chat = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role !== "system");
    let id = "";
    await act(async () => {
      id = (await result.current.create.mutateAsync({ fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "Two, folded" })).fold.id;
    });
    await waitFor(() => expect(result.current.folds.data?.folds.map((fold) => fold.id)).toEqual([id]));
    await act(async () => {
      await result.current.remove.mutateAsync({ foldId: id });
    });
    await waitFor(() => expect(result.current.folds.data?.folds).toEqual([]));
  });
});
