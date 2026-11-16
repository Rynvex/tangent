import type { LineView, Message } from "@tangent/client";
import { normalizeDecomposePlan } from "@tangent/client";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageActionModel } from "../conversation/message-actions";
import { useExtractBranch, useImportConversation, useLineOrganization, useRenameFolder, useUpdateLineOrganization } from "../data/b18-hooks";
import { useTangentEvents } from "../data/live-hooks";
import { useLines, useMessages } from "../data/queries";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { countSuggestions, detourTopic, rangeMessageIds, spinoffCandidate, visibleCards, type DecomposeAbilities } from "./decompose-model";
import { DecomposePanel } from "./decompose-panel";
import { ExtractBranchDialog } from "./extract-branch-dialog";
import { rangeHighlightCss } from "./range-highlight";

const clients: Array<{ mock: { dispose(): void } }> = [];
function tracked() {
  const client = mockClient();
  clients.push(client);
  return client;
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

/** A conversation with a Docker detour at #3–#4 and a closing question (the mock's decompose finds both). */
const CONVERSATION = [
  { role: "user" as const, content: "Explain Postgres MVCC" },
  { role: "assistant" as const, content: "Snapshots per transaction." },
  { role: "user" as const, content: "Docker cannot reach the host Postgres: connection refused error" },
  { role: "assistant" as const, content: "Use host.docker.internal instead. Or the host network." },
  { role: "user" as const, content: "Back to Postgres MVCC: when does vacuum run?" },
  { role: "assistant" as const, content: "When dead tuples pass a threshold.\n- Should the scale factor change?\nWant an example?" },
];

async function imported(client: ReturnType<typeof tracked>, extra: { title?: string; tags?: string[] } = {}): Promise<{ line: LineView; messages: Message[] }> {
  const result = await client.importConversation({ title: extra.title ?? "Postgres MVCC", ...(extra.tags ? { tags: extra.tags } : {}), messages: CONVERSATION });
  return { line: result.line, messages: (await client.listMessages(result.line.id)).messages };
}

describe("B18 hooks", () => {
  it("resets both lines' messages after an extract, so the marker at an older seq shows in its place", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ messages: useMessages(line.id), extract: useExtractBranch(line.id) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.messages.data?.messages).toHaveLength(6));
    let branchLineId = "";
    let markerId = "";
    await act(async () => {
      const done = await result.current.extract.mutateAsync({ fromMessageId: messages[2]!.id, toMessageId: messages[3]!.id, purpose: "Docker", card: { question: "Why?", conclusion: "host.docker.internal" } });
      branchLineId = done.branch.lineId;
      markerId = done.marker.id;
    });
    await waitFor(() => expect(result.current.messages.data?.messages.map((message) => message.id)).toEqual([messages[0]!.id, messages[1]!.id, markerId, messages[4]!.id, messages[5]!.id]));
    // The marker's seq is older than the newest message the cache had read: only a reset brings it.
    expect(result.current.messages.data!.messages[2]!.seq).toBeLessThan(messages[5]!.seq);
    const branch = renderHook(() => useMessages(branchLineId), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(branch.result.current.data?.messages.map((message) => message.content)).toEqual([CONVERSATION[2]!.content, CONVERSATION[3]!.content]));
  });

  it("writes a line's tags and folder, and the filtered lists follow", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ tagged: useLines({ tag: "zfs" }), organize: useUpdateLineOrganization(), rename: useRenameFolder() }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.tagged.data?.lines.map((line) => line.id)).toEqual(["nas"]));
    await act(async () => {
      await result.current.organize.mutateAsync({ lineId: "rust", tags: ["rust", "zfs"], folder: "Learning" });
    });
    await waitFor(() => expect(result.current.tagged.data?.lines.map((line) => line.id).sort()).toEqual(["nas", "rust"]));
    await act(async () => {
      expect((await result.current.rename.mutateAsync({ from: "Learning", to: "" })).updated).toBe(1);
    });
    expect((await client.getLine("rust")).folder).toBe("");
  });
});

describe("the tenant's folders and tags (B18.1)", () => {
  it("reads every main line's counts and reloads them after a write that changes a folder or tags", async () => {
    const client = tracked();
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ organization: useLineOrganization(), organize: useUpdateLineOrganization(), rename: useRenameFolder(), importing: useImportConversation() }), {
      wrapper: tangentWrapper(client, queryClient),
    });
    await waitFor(() => expect(result.current.organization.data?.folders.map((item) => item.folder)).toEqual(["家用設備", "旅行"]));
    expect(result.current.organization.data?.tags.find((item) => item.tag === "rust")).toEqual({ tag: "rust", count: 1 });
    await act(async () => {
      await result.current.organize.mutateAsync({ lineId: "okr", tags: ["rust"], folder: "Learning" });
    });
    await waitFor(() => expect(result.current.organization.data?.tags.find((item) => item.tag === "rust")?.count).toBe(2));
    expect(result.current.organization.data?.folders.find((item) => item.folder === "Learning")).toEqual({ folder: "Learning", active: 1, archived: 0 });
    await act(async () => {
      await result.current.rename.mutateAsync({ from: "Learning", to: "Study" });
    });
    await waitFor(() => expect(result.current.organization.data?.folders.map((item) => item.folder)).toContain("Study"));
    await act(async () => {
      await result.current.importing.mutateAsync({ folder: "Study", tags: ["rust"], messages: CONVERSATION });
    });
    await waitFor(() => expect(result.current.organization.data?.folders.find((item) => item.folder === "Study")?.active).toBe(2));
  });

  it("reloads them when another tab creates, re-tags, archives or deletes a conversation", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => {
        useTangentEvents({});
        return useLineOrganization();
      },
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.data?.tags.find((item) => item.tag === "rust")?.count).toBe(1));
    await client.updateLine("okr", { tags: ["rust"] });
    await waitFor(() => expect(result.current.data?.tags.find((item) => item.tag === "rust")?.count).toBe(2));
    await client.archiveLine("okr");
    await waitFor(() => expect(result.current.data?.tags.find((item) => item.tag === "rust")?.count).toBe(1));
    const made = await client.importConversation({ folder: "旅行", messages: CONVERSATION });
    await waitFor(() => expect(result.current.data?.folders.find((item) => item.folder === "旅行")?.active).toBe(2));
    await client.deleteLine(made.line.id);
    await waitFor(() => expect(result.current.data?.folders.find((item) => item.folder === "旅行")?.active).toBe(1));
  });
});

describe("event sync of folders and tags", () => {
  it("reloads a #tag list when another tab gives a conversation that tag (it was never on that page)", async () => {
    const client = tracked();
    const { result } = renderHook(
      () => {
        useTangentEvents({});
        return useLines({ tag: "borrow" });
      },
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.data?.lines).toEqual([]));
    await client.updateLine("rust", { tags: ["rust", "borrow"] });
    await waitFor(() => expect(result.current.data?.lines.map((line) => line.id)).toEqual(["rust"]));
  });
});

describe("ExtractBranchDialog", () => {
  it("starts a reply's range at its question, ends at the last reply before a boundary, and leaves a card", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    const onExtracted = vi.fn();
    const onRange = vi.fn();
    render(<ExtractBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} branches={[]} cutMessageIds={new Set([messages[4]!.id])} triggerMessageId={messages[3]!.id} onRangeChange={onRange} onExtracted={onExtracted} />, {
      wrapper: tangentWrapper(client),
    });
    const dialog = await screen.findByRole("dialog", { name: "Move from #3 into a branch" });
    expect(within(dialog).getByText("Opened from a reply: the range starts at this turn’s question, #3.")).toBeInTheDocument();
    expect(within(dialog).getByText(/2 messages · branch starts at #2 · #3–#4/)).toBeInTheDocument();
    expect(onRange).toHaveBeenLastCalledWith([messages[2]!.id, messages[3]!.id]);
    expect(within(dialog).getByRole("textbox", { name: /Conclusion/ })).toHaveValue("Use host.docker.internal instead.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move and leave conclusion" }));
    await waitFor(() => expect(onExtracted).toHaveBeenCalledOnce());
    expect(onExtracted.mock.calls[0]![0]).toMatchObject({ marker: { kind: "branch_card" }, branch: { status: "merged" } });
  });

  it("leaves a marker when unchecked", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    const onExtracted = vi.fn();
    render(<ExtractBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} branches={[]} triggerMessageId={messages[4]!.id} onExtracted={onExtracted} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Mark as merged/ }));
    expect(within(dialog).getByText(/the main line shows “Moved 2 messages to a branch”/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Move into branch" }));
    await waitFor(() => expect(onExtracted.mock.calls[0]![0]).toMatchObject({ marker: { kind: "branch_marker" }, branch: { status: "open" } }));
  });

  it("explains why the first turn cannot be moved and keeps the button disabled", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    const onExtracted = vi.fn();
    render(<ExtractBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} branches={[]} triggerMessageId={messages[1]!.id} onExtracted={onExtracted} />, { wrapper: tangentWrapper(client) });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This is the first turn");
    const submit = within(dialog).getByRole("button", { name: "Move and leave conclusion" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(submit);
    expect(onExtracted).not.toHaveBeenCalled();
  });
});

describe("DecomposePanel", () => {
  const renderPanel = async (client: ReturnType<typeof tracked>, line: LineView, messages: Message[], extra: Record<string, unknown> = {}) => {
    const onHighlight = vi.fn();
    render(<DecomposePanel line={line} rootLine={line} messages={messages} branches={[]} onClose={() => undefined} onHighlight={onHighlight} onNavigate={() => undefined} {...extra} />, {
      wrapper: tangentWrapper(client, testQueryClient(), (extra.readOnly ? { readOnly: true } : {}) as never),
    });
    await screen.findByRole("heading", { name: "Detours" });
    return { onHighlight };
  };

  it("shows the four kinds of suggestions and outlines a detour while it is hovered", async () => {
    const client = tracked();
    const { line, messages } = await imported(client, { tags: ["nas"] });
    const { onHighlight } = await renderPanel(client, line, messages);
    expect(screen.getByText(/#3–#4 \(2 messages\) wander off the main line/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tags and to-dos" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Related and split" })).toBeInTheDocument();
    await userEvent.hover(screen.getByText(/wander off the main line/));
    expect(onHighlight).toHaveBeenLastCalledWith([messages[2]!.id, messages[3]!.id]);
  });

  it("folds a detour in place with the suggested summary, and undoes it", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    await renderPanel(client, line, messages);
    await userEvent.click(screen.getByRole("button", { name: "Fold into a summary" }));
    await screen.findByText("Folded into a summary");
    const [fold] = (await client.listFolds(line.id)).folds;
    expect(fold).toMatchObject({ fromMessageId: messages[2]!.id, toMessageId: messages[3]!.id, summary: "Use host.docker.internal instead." });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Fold into a summary" })).toBeInTheDocument());
  });

  it("adds a suggested tag to the main line and parks the open items", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    await renderPanel(client, line, messages);
    await userEvent.click(screen.getByRole("button", { name: "Add tag #postgres" }));
    await waitFor(async () => expect((await client.getLine(line.id)).tags).toContain("postgres"));
    await userEvent.click(screen.getByRole("button", { name: "Park 2 items" }));
    await screen.findByText("Parked 2 items");
    expect((await client.listSeeds(line.id)).seeds.map((seed) => seed.text).sort()).toEqual(["Should the scale factor change?", "Want an example?"]);
  });

  it("offers nothing to apply to a viewer", async () => {
    const client = tracked();
    const { line, messages } = await imported(client);
    await renderPanel(client, line, messages, { readOnly: true });
    expect(screen.getByText("You can read these suggestions; applying them needs write access.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move and leave conclusion" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fold into a summary" })).toBeNull();
  });
});

describe("decompose model", () => {
  const all: DecomposeAbilities = { write: true, fold: true, chapters: true, parking: true, relations: true, spinoff: true, tags: true };
  const plan = normalizeDecomposePlan({
    detourRanges: [{ fromMessageId: "a", toMessageId: "b", purpose: "了解：Docker" }],
    chapterCuts: [{ messageId: "c", reason: "topic_shift" }],
    seedCandidates: [{ messageId: "d", text: "x" }],
    relatedLines: [],
  });

  it("counts and hides by feature", () => {
    expect(countSuggestions(plan, ["t"], all)).toBe(4);
    expect(countSuggestions(plan, ["t"], { ...all, chapters: false, parking: false })).toBe(2);
    expect(visibleCards(plan, [], { ...all, parking: false }, null)).toEqual({ detours: true, chapters: true, tagsAndSeeds: false, related: false });
    expect(detourTopic("了解：Docker")).toBe("Docker");
    expect(detourTopic("Look into: x")).toBe("x");
  });

  it("finds a split from #3 on and the ids a range covers", () => {
    expect(spinoffCandidate(plan.chapterCuts, new Map([["c", 2]]))).toBeNull();
    expect(spinoffCandidate(plan.chapterCuts, new Map([["c", 9]]))?.messageId).toBe("c");
    const messages = ["x", "y", "z"].map((id, index) => ({ id, seq: index + 1 })) as Message[];
    expect(rangeMessageIds(messages, "y", "z")).toEqual(["y", "z"]);
    expect(rangeMessageIds(messages, "z", "y")).toEqual([]);
  });
});

describe("range highlight and the menu item", () => {
  it("outlines the range's rows (escaped ids) and dims the rest only when asked", () => {
    expect(rangeHighlightCss([])).toBe("");
    const css = rangeHighlightCss(['a"b'], true);
    expect(css).toContain('[data-tg-message="a\\"b"]');
    expect(css).toContain("outline: 2px solid var(--tg-primary)");
    expect(css).toContain("opacity: 0.4");
    expect(rangeHighlightCss(["a"])).not.toContain("opacity");
  });

  it("offers 從這則抽成支線… on both roles when the host wires it", () => {
    const ids = (role: "user" | "assistant") => messageActionModel({ text: "x", role, onExtract: () => undefined }).groups.flat().map((item) => item.id);
    expect(ids("user")).toContain("extract");
    expect(ids("assistant")).toContain("extract");
    expect(messageActionModel({ text: "x", role: "user" }).groups.flat().map((item) => item.id)).not.toContain("extract");
  });
});
