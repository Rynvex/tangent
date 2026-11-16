import { NAS_ROOT_ID } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { useCreateBranch, useDiscardBranch, useMergeBranch, useMoveToBranch, usePromoteBranch, useStartDraft } from "./branch-mutations";
import { useBranchDetail, useNotes } from "./branch-queries";
import { useAddMilestone, useChapters, useDeleteMilestone } from "./chapter-hooks";
import { useTangentEvents } from "./live-hooks";
import { useBranches, useLine, useMessages } from "./queries";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient({ draftMs: 10 });
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

describe("branch reads", () => {
  it("read a branch's detail and the tree's notes", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ detail: useBranchDetail("nas-b3"), notes: useNotes(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.detail.isSuccess && result.current.notes.isSuccess).toBe(true));
    expect(result.current.detail.data?.branch.purpose).toBe("4TB 與 8TB 硬碟的每 TB 成本與保固");
    expect(result.current.notes.data?.notes.length).toBeGreaterThan(0);
  });
});

describe("branch writes", () => {
  it("opens a branch: the new line is cached and the outline reloads", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ create: useCreateBranch(NAS_ROOT_ID), branches: useBranches(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.branches.isSuccess).toBe(true));
    let lineId = "";
    await act(async () => {
      lineId = (await result.current.create.mutateAsync({ purpose: "UPS", kind: "investigate", anchorMessageId: "nas-m40" })).line.id;
    });
    await waitFor(() => expect(result.current.branches.data?.branches.some((branch) => branch.lineId === lineId)).toBe(true));
    const { result: line } = renderHook(() => useLine(lineId), { wrapper: tangentWrapper(client, queryClient) });
    expect(line.current.data?.conversationBranch?.purpose).toBe("UPS");
  });

  it("drafts and merges: the card shows in the parent's cached messages at once", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => {
        // branch.changed (draft ready) refreshes the detail.
        useTangentEvents();
        return { draft: useStartDraft("nas-b3"), merge: useMergeBranch("nas-b3"), detail: useBranchDetail("nas-b3"), parent: useMessages(NAS_ROOT_ID) };
      },
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.parent.isSuccess && result.current.detail.isSuccess).toBe(true));
    await act(async () => {
      await result.current.draft.mutateAsync();
    });
    await waitFor(() => expect(result.current.detail.data?.draft.status).toBe("ready"), { timeout: 2000 });
    const detail = result.current.detail.data!;
    let cardId = "";
    await act(async () => {
      cardId = (await result.current.merge.mutateAsync({ card: detail.draft.card!, parentTipMessageId: detail.parentTipMessageId })).message.id;
    });
    await waitFor(() => expect(result.current.parent.data?.messages.some((message) => message.id === cardId && message.kind === "branch_card")).toBe(true));
    await waitFor(() => expect(result.current.detail.data?.branch.status).toBe("merged"));
  });

  it("discards a branch", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ discard: useDiscardBranch("nas-b3"), detail: useBranchDetail("nas-b3") }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.detail.isSuccess).toBe(true));
    await act(async () => {
      await result.current.discard.mutateAsync();
    });
    await waitFor(() => expect(result.current.detail.data?.branch.status).toBe("discarded"));
  });

  it("moves the tail: the source's messages reload without it", async () => {
    const client = tracked();
    const { result } = renderHook(() => ({ move: useMoveToBranch(NAS_ROOT_ID), messages: useMessages(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    await act(async () => {
      await result.current.move.mutateAsync({ count: 2, purpose: "異地備份", kind: "investigate" });
    });
    await waitFor(() => expect(result.current.messages.data?.messages.some((message) => message.id === "nas-m40")).toBe(false));
    expect(result.current.messages.data?.messages.at(-1)?.kind).toBe("branch_marker");
  });

  it("promotes a branch: the main line's messages reload", async () => {
    const client = tracked();
    await client.discardBranch("nas-b2");
    const created = await client.createBranch(NAS_ROOT_ID, { purpose: "雲端", kind: "alternative", anchorMessageId: "nas-m26" });
    const { result } = renderHook(() => ({ promote: usePromoteBranch(created.line.id), messages: useMessages(NAS_ROOT_ID) }), { wrapper: tangentWrapper(client) });
    await waitFor(() => expect(result.current.messages.isSuccess).toBe(true));
    await act(async () => {
      await result.current.promote.mutateAsync();
    });
    await waitFor(() => expect(result.current.messages.data?.messages.some((message) => message.id === "nas-m40")).toBe(false));
  });
});

describe("another tab ends the branch (R2)", () => {
  it("flips this tab's open branch line to ended when the event arrives", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => {
        useTangentEvents();
        return useLine("nas-b3");
      },
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.data?.conversationBranch?.status).toBe("open"));
    // The other tab's write: no cache of this tab is touched, only the event stream tells.
    await client.discardBranch("nas-b3");
    await waitFor(() => expect(result.current.data?.conversationBranch?.status).toBe("discarded"));
  });
});

describe("chapters (F2 phase 2)", () => {
  it("reads a line's chapters and adds and removes a milestone", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => ({ chapters: useChapters(NAS_ROOT_ID, NAS_ROOT_ID), add: useAddMilestone(NAS_ROOT_ID, NAS_ROOT_ID), remove: useDeleteMilestone(NAS_ROOT_ID, NAS_ROOT_ID) }),
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.chapters.data?.chapters).toHaveLength(4));
    let id = "";
    await act(async () => {
      id = (await result.current.add.mutateAsync({ messageId: "nas-m26", title: "Decided" })).milestone.id;
    });
    await waitFor(() => expect(result.current.chapters.data?.chapters.map((chapter) => chapter.title)).toContain("Decided"));
    await act(async () => {
      await result.current.remove.mutateAsync(id);
    });
    await waitFor(() => expect(result.current.chapters.data?.chapters).toHaveLength(4));
  });
});
