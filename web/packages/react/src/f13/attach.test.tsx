/** F15: 併為此對話的支線 from the decompose panel (B20 `POST /lines/{id}/attach`), the dialog and `useAttachLine`. */
import type { LineView, Message } from "@tangent/client";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAttachLine } from "../data/b18-hooks";
import { useTangentEvents } from "../data/live-hooks";
import { useLines } from "../data/queries";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import { AttachLineDialog } from "./attach-line-dialog";
import { DecomposePanel } from "./decompose-panel";

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

const DETOUR = [
  { role: "user" as const, content: "Explain Postgres MVCC" },
  { role: "assistant" as const, content: "Snapshots per transaction." },
  { role: "user" as const, content: "Docker cannot reach the host Postgres: connection refused error" },
  { role: "assistant" as const, content: "Use host.docker.internal instead. Or the host network." },
];

/** A target and, sharing its tag, another conversation that belongs to it. */
async function pair(client: ReturnType<typeof tracked>): Promise<{ line: LineView; messages: Message[]; source: LineView }> {
  const target = await client.importConversation({ title: "Postgres MVCC", tags: ["pgx"], messages: DETOUR });
  const source = await client.importConversation({ title: "PgBouncer pool modes", tags: ["pgx"], messages: [{ role: "user", content: "Which pool_mode?" }, { role: "assistant", content: "transaction" }] });
  return { line: target.line, messages: (await client.listMessages(target.line.id)).messages, source: source.line };
}

async function renderPanel(client: ReturnType<typeof tracked>, line: LineView, messages: Message[], extra: Record<string, unknown> = {}) {
  const onNavigate = vi.fn();
  render(<DecomposePanel line={line} rootLine={line} messages={messages} branches={[]} onClose={() => undefined} onHighlight={() => undefined} onNavigate={onNavigate} {...extra} />, {
    wrapper: tangentWrapper(client, testQueryClient(), (extra.readOnly ? { readOnly: true } : {}) as never),
  });
  await screen.findByRole("heading", { name: "Related and split" });
  return { onNavigate };
}

describe("RelatedCard: 併為支線…", () => {
  it("attaches a related conversation with its card, then offers the way to the branch", async () => {
    // Arrange
    const client = tracked();
    const { line, messages, source } = await pair(client);
    const onAttached = vi.fn();
    const { onNavigate } = await renderPanel(client, line, messages, { onAttached });
    const row = document.querySelector<HTMLElement>(`[data-tg-related="${source.id}"]`)!;
    // Act
    await userEvent.click(within(row).getByRole("button", { name: "Attach as a branch…" }));
    const dialog = await screen.findByRole("dialog", { name: "Attach as a branch of this conversation" });
    expect(within(dialog).getByText("PgBouncer pool modes")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Attach and leave a conclusion card/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    expect(within(dialog).getByText("Write the conclusion, or attach it as an open branch.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Conclusion/ }), "Use transaction mode.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    // Assert
    await waitFor(() => expect(onAttached).toHaveBeenCalledOnce());
    expect(onAttached.mock.calls[0]![0]).toMatchObject({ branch: { lineId: source.id, status: "merged", parentLineId: line.id }, cardMessage: { kind: "branch_card" } });
    expect(await within(row).findByText("Attached as a branch")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Attach as a branch…" })).toBeNull();
    // Its 併為支線… is gone: focus lands on 前往支線, which says it worked.
    await waitFor(() => expect(within(row).getByRole("button", { name: "Go to the branch" })).toHaveFocus());
    await userEvent.click(within(row).getByRole("button", { name: "Go to the branch" }));
    expect(onNavigate).toHaveBeenCalledWith(source.id);
    expect((await client.getLine(source.id)).conversationBranch).toMatchObject({ rootLineId: line.id, status: "merged" });
  });

  it("attaches any other loaded conversation as an open branch from 併入其他既有對話…", async () => {
    // Arrange
    const client = tracked();
    const { line, messages } = await pair(client);
    const other = (await client.importConversation({ title: "Statement timeouts", messages: [{ role: "user", content: "statement_timeout?" }, { role: "assistant", content: "30 s" }] })).line;
    await renderPanel(client, line, messages);
    // Act
    await userEvent.click(screen.getByRole("button", { name: "Attach another conversation…" }));
    const dialog = await screen.findByRole("dialog", { name: "Attach as a branch of this conversation" });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Conversation to attach" }));
    await userEvent.click(await screen.findByRole("option", { name: "Statement timeouts" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /Attach as an open branch/ }));
    expect(within(dialog).queryByRole("textbox", { name: /Conclusion/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    // Assert
    expect(await screen.findByText("Attached “Statement timeouts” as a branch")).toBeInTheDocument();
    expect((await client.getLine(other.id)).conversationBranch).toMatchObject({ parentLineId: line.id, status: "open" });
  });

  it("offers no attach to a viewer", async () => {
    const client = tracked();
    const { line, messages } = await pair(client);
    await renderPanel(client, line, messages, { readOnly: true });
    expect(screen.queryByRole("button", { name: "Attach as a branch…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Attach another conversation…" })).toBeNull();
  });
});

describe("AttachLineDialog", () => {
  it("hangs the source on the anchor chosen and says why a refusal happened", async () => {
    const client = tracked();
    const { line, messages, source } = await pair(client);
    const onAttached = vi.fn();
    await client.archiveLine(source.id);
    render(<AttachLineDialog open onOpenChange={() => undefined} line={line} messages={messages} rootLineId={line.id} source={{ lineId: source.id, title: source.title }} onAttached={onAttached} />, {
      wrapper: tangentWrapper(client),
    });
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Conclusion/ }), "done");
    await userEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    expect(await within(dialog).findByText("One of the two conversations is archived.")).toBeInTheDocument();
    expect(onAttached).not.toHaveBeenCalled();
  });

  it("filters candidate conversations by title when more than 3 main lines exist", async () => {
    const client = tracked();
    const { line, messages } = await pair(client);
    for (const title of ["Statement timeouts", "Autovacuum tuning", "Index bloat check"]) {
      await client.importConversation({ title, messages: [{ role: "user", content: title }, { role: "assistant", content: "ok" }] });
    }
    render(<AttachLineDialog open onOpenChange={() => undefined} line={line} messages={messages} rootLineId={line.id} source={null} onAttached={() => undefined} />, {
      wrapper: tangentWrapper(client),
    });
    const dialog = await screen.findByRole("dialog");
    const filter = await within(dialog).findByRole("textbox", { name: "Filter conversations" });
    await userEvent.type(filter, "Autovacuum");
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Conversation to attach" }));
    expect(await screen.findByRole("option", { name: "Autovacuum tuning" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Statement timeouts" })).toBeNull();
  });
});

describe("useAttachLine", () => {
  it("drops the source from the cached lists and reloads the target's messages", async () => {
    const client = tracked();
    const { line, source } = await pair(client);
    const queryClient = testQueryClient();
    const { result } = renderHook(() => ({ lines: useLines(), attach: useAttachLine(line.id) }), { wrapper: tangentWrapper(client, queryClient) });
    await waitFor(() => expect(result.current.lines.data?.lines.map((item) => item.id)).toContain(source.id));
    await act(async () => {
      await result.current.attach.mutateAsync({ sourceLineId: source.id, status: "merged", card: { conclusion: "c" } });
    });
    await waitFor(() => expect(result.current.lines.data?.lines.map((item) => item.id)).not.toContain(source.id));
  });

  it("drops a conversation another tab attached when its line.updated says it is a branch now", async () => {
    const client = tracked();
    const { line, source } = await pair(client);
    const { result } = renderHook(
      () => {
        useTangentEvents({});
        return useLines();
      },
      { wrapper: tangentWrapper(client) },
    );
    await waitFor(() => expect(result.current.data?.lines.map((item) => item.id)).toContain(source.id));
    await client.attachLine(line.id, { sourceLineId: source.id });
    await waitFor(() => expect(result.current.data?.lines.map((item) => item.id)).not.toContain(source.id));
  });
});
