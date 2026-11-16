import type { BranchList, TermList } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario, type MockTangentClient } from "@tangent/client/testing";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangent } from "../provider";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { TERM_LOOKUP_TIMEOUT_MS, useSaveTerm, useTermSearch, useUpdateTerm } from "./glossary-hooks";
import { useTerms } from "./glossary-query";
import { useBranches } from "./queries";

/** B24 / F19: the glossary's cache follows its writes at once, and nothing is asked while the feature is off. */

const clients: MockTangentClient[] = [];
function tracked(options: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient(options);
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
  vi.useRealTimers();
});

function useScreen(enabled: boolean) {
  const outline = useBranches(NAS_ROOT_ID, true);
  void outline.data;
  return { ctx: useTangent(), terms: useTerms(NAS_ROOT_ID, enabled), outline, save: useSaveTerm(), update: useUpdateTerm() };
}

async function answeredAside(client: MockTangentClient) {
  const made = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "What is a scrub?", kind: "aside" });
  await client.sendMessage(made.line.id, { content: "What is a scrub?" });
  await waitFor(async () => expect((await client.getBranch(made.line.id)).branch.status).toBe("discarded"));
  return made.line.id;
}

describe("useTerms", () => {
  it("asks for nothing while the feature is off", async () => {
    // Arrange
    const client = tracked({ scenario: nasScenario({ features: "core" }) });
    const listTerms = vi.spyOn(client, "listTerms");

    // Act
    const { result } = renderHook(() => useTerms(NAS_ROOT_ID, false), { wrapper: tangentWrapper(client) });
    await act(() => Promise.resolve());

    // Assert
    expect(listTerms).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });
});

describe("useSaveTerm", () => {
  it("puts the saved term into the tree's list at once, in key order, and marks the aside it kept in the outline", async () => {
    // Arrange
    const client = tracked();
    const asideId = await answeredAside(client);
    await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "a filesystem" });
    const queryClient = testQueryClient();
    const { result } = renderHook(() => useScreen(true), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.terms.data?.terms).toHaveLength(1));
    await waitFor(() => expect(result.current.outline.data?.branches.some((branch) => branch.lineId === asideId)).toBe(true));
    // The reloads that follow are held back, so what shows now is what the write itself put there.
    const listTerms = vi.spyOn(client, "listTerms").mockReturnValue(new Promise(() => undefined));
    const listBranches = vi.spyOn(client, "listBranches").mockReturnValue(new Promise(() => undefined));

    // Act
    await act(() => result.current.save.mutateAsync({ lineId: asideId, input: { term: "scrub", explanation: "A full read that checks every block." } }));

    // Assert
    const { keys } = result.current.ctx;
    expect(queryClient.getQueryData<TermList>(keys.terms(NAS_ROOT_ID))?.terms.map((term) => term.term)).toEqual(["scrub", "ZFS"]);
    const outline = queryClient.getQueryData<BranchList>(keys.branches(NAS_ROOT_ID, true));
    expect(outline?.branches.find((branch) => branch.lineId === asideId)?.keptAt).toEqual(expect.any(String));
    expect(listTerms).toHaveBeenCalled();
    expect(listBranches).not.toHaveBeenCalled();
  });

  it("an edit replaces the term's copy in the list", async () => {
    const client = tracked();
    const made = await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "old" });
    const queryClient = testQueryClient();
    const { result } = renderHook(() => useScreen(true), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.terms.data?.terms).toHaveLength(1));
    await act(() => result.current.update.mutateAsync({ termId: made.term.id, input: { explanation: "new" } }));
    expect(queryClient.getQueryData<TermList>(result.current.ctx.keys.terms(NAS_ROOT_ID))?.terms).toEqual([expect.objectContaining({ id: made.term.id, explanation: "new" })]);
  });
});

describe("useTermSearch", () => {
  it("is not sent for an empty query, and gives up after the time limit without retrying", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = tracked();
    const searchTerms = vi.spyOn(client, "searchTerms").mockImplementation((_query, opts) => new Promise((_resolve, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const { result, rerender } = renderHook(({ q }: { q: string }) => useTermSearch(q), { wrapper: tangentWrapper(client), initialProps: { q: "" } });
    expect(searchTerms).not.toHaveBeenCalled();

    // Act
    rerender({ q: "mvcc" });
    await waitFor(() => expect(searchTerms).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(TERM_LOOKUP_TIMEOUT_MS + 10));

    // Assert
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(searchTerms).toHaveBeenCalledTimes(1);
  });
});
