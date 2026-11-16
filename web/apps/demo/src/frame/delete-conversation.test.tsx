// @vitest-environment jsdom
import type { DeleteLineResult, LineView, TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationMenu } from "./conversation-menu";
import { DeleteConversationDialog } from "./delete-conversation";

/** F7: the conversation menu and the delete confirmation, as the frame wires them (the menu asks, the dialog confirms). */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function Host({ line, onDeleted }: { line: LineView; onDeleted: (result: DeleteLineResult) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ConversationMenu line={line} onDelete={() => setOpen(true)} />
      <DeleteConversationDialog
        open={open}
        onOpenChange={setOpen}
        line={line}
        onDeleted={(result) => {
          setOpen(false);
          onDeleted(result);
        }}
      />
    </>
  );
}

async function setup(lineId = NAS_ROOT_ID) {
  const client = createMockTangentClient({ latencyMs: 0, chunkMs: 5, scenario: nasScenario() });
  mocks.push(client);
  const line = await client.getLine(lineId);
  const onDeleted = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client as TangentClient} locale="zh-TW">
        <Host line={line} onDeleted={onDeleted} />
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { client, line, onDeleted };
}

async function openDialog(title: string) {
  await userEvent.click(screen.getByRole("button", { name: `「${title}」的動作` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "刪除對話…" }));
  return screen.findByRole("dialog", { name: `刪除「${title}」？` });
}

describe("ConversationMenu (F7)", () => {
  it("offers 封存對話 and 刪除對話… (destructive) for an active conversation, 解除封存 for an archived one", async () => {
    const { client } = await setup();
    await userEvent.click(screen.getByRole("button", { name: "「家用 NAS 與備份策略」的動作" }));
    const items = await screen.findAllByRole("menuitem");
    // F8 S5 put 重新命名… and 置頂對話 first.
    expect(items.map((item) => item.textContent).slice(-2)).toEqual(["封存對話", "刪除對話…"]);
    expect(items.at(-1)).toHaveClass("text-tg-destructive");
    await userEvent.click(items.at(-2)!);
    await waitFor(async () => expect((await client.getLine(NAS_ROOT_ID)).archivedAt).not.toBeNull());
  });

  it("restores an archived conversation from the same menu", async () => {
    await setup("arch-1");
    await userEvent.click(screen.getByRole("button", { name: "「Proxmox 叢集規劃」的動作" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent).slice(-2)).toEqual(["解除封存", "刪除對話…"]);
  });
});

describe("DeleteConversationDialog (F7)", () => {
  it("says the whole tree goes, with its branch count, that it cannot be undone, and suggests archiving; focus starts on 取消", async () => {
    const { client } = await setup();
    const count = (await client.listBranches(NAS_ROOT_ID, { includeAside: true })).branches.length;
    const dialog = await openDialog("家用 NAS 與備份策略");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("刪除後不能復原。");
    expect(await within(dialog).findByText(`會刪掉整棵對話：主線、${count} 條支線（不論開著或已結束），以及其中所有訊息、紀要與章節。`)).toBeInTheDocument();
    expect(within(dialog).getByText("只是不想在清單上看到它？改用封存，之後還能解除封存。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "刪除對話" })).toHaveClass("text-tg-destructive");
  });

  it("closes on Esc without deleting", async () => {
    const { client, onDeleted } = await setup();
    const spy = vi.spyOn(client, "deleteLine");
    await openDialog("家用 NAS 與備份策略");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(spy).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("deletes on 刪除對話 and reports every line of the tree", async () => {
    const { onDeleted } = await setup();
    const dialog = await openDialog("家用 NAS 與備份策略");
    await userEvent.click(within(dialog).getByRole("button", { name: "刪除對話" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onDeleted.mock.calls[0]![0]).toMatchObject({ rootLineId: NAS_ROOT_ID, lineIds: expect.arrayContaining([NAS_ROOT_ID, "nas-b1"]) });
  });

  it("shows the server's refusal while a reply is running (session_busy) and stays open", async () => {
    const { client, onDeleted } = await setup();
    await client.sendMessage("nas-b2", { content: "[fake:slow] still thinking" });
    const dialog = await openDialog("家用 NAS 與備份策略");
    await userEvent.click(within(dialog).getByRole("button", { name: "刪除對話" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("這段對話裡還有正在回覆的回合。等它結束（或先停止）再刪除。");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("改為封存 archives instead and closes", async () => {
    const { client } = await setup();
    const dialog = await openDialog("家用 NAS 與備份策略");
    await userEvent.click(within(dialog).getByRole("button", { name: "改為封存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect((await client.getLine(NAS_ROOT_ID)).archivedAt).not.toBeNull();
  });

  it("for an archived conversation: no 改為封存, and it says deleting ends the way back", async () => {
    await setup("arch-1");
    const dialog = await openDialog("Proxmox 叢集規劃");
    expect(within(dialog).queryByRole("button", { name: "改為封存" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("它已封存；刪除後就不能再解除封存。")).toBeInTheDocument();
    expect(await within(dialog).findByText("會刪掉這段對話與其中所有訊息、紀要與章節。它沒有支線。")).toBeInTheDocument();
  });
});
