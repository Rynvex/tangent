/** F6 phase 2: give me directions (D3), the diverge marker with the comparison table, and editing a fold's summary. */
import type { BranchView, Message } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangentEvents } from "../data/live-hooks";
import { useBranches } from "../data/queries";
import { mockClient, tangentWrapper } from "../test-utils";
import { DivergeDialog } from "./diverge-dialog";
import { DivergeMarker } from "./diverge-marker";
import { CompareTable } from "./compare-table";
import { FoldBlock } from "./fold-block";

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup({ readOnly = false } = {}) {
  const scenario = nasScenario();
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = mockClient({ scenario, draftMs: 5 });
  clients.push(client);
  return { client, wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) };
}

const lastReply = async (client: ReturnType<typeof setup>["client"]): Promise<Message> => (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.role === "assistant" && message.kind === "chat").at(-1)!;

/** The marker as the transcript shows it: fed from the live outline. */
function LiveMarker({ anchorMessageId, onEnter }: { anchorMessageId: string; onEnter: (lineId: string) => void }) {
  useTangentEvents();
  const outline = useBranches(NAS_ROOT_ID, true);
  const group: BranchView[] = (outline.data?.branches ?? []).filter((branch) => branch.origin === "diverge" && branch.anchorMessageId === anchorMessageId);
  if (group.length === 0) return null;
  return <DivergeMarker lineId={NAS_ROOT_ID} branches={group} onEnter={onEnter} />;
}

describe("DivergeDialog (給我幾個方向)", () => {
  it("asks for N directions (2–5, keyboard), waits, and closes once they are opened", async () => {
    const { client, wrapper } = setup();
    const anchor = await lastReply(client);
    const onOpenChange = vi.fn();
    render(
      <>
        <DivergeDialog open onOpenChange={onOpenChange} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} anchor={anchor} />
        <LiveMarker anchorMessageId={anchor.id} onEnter={vi.fn()} />
      </>,
      { wrapper },
    );
    const dialog = await screen.findByRole("dialog", { name: "給我幾個方向" });
    const counts = within(dialog).getByRole("radiogroup", { name: "幾個方向" });
    expect(within(counts).getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual(["2", "3", "4", "5"]);
    expect(within(counts).getByRole("radio", { name: "3" })).toBeChecked();
    within(counts).getByRole("radio", { name: "3" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(counts).getByRole("radio", { name: "4" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "給我 4 個方向" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect((await client.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge")).toHaveLength(4);
  });

  it("says why when the directions cannot be opened", async () => {
    const { client, wrapper } = setup();
    const anchor = await lastReply(client);
    render(<DivergeDialog open onOpenChange={vi.fn()} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} anchor={{ ...anchor, id: "gone" }} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "給我幾個方向" });
    await userEvent.click(within(dialog).getByRole("button", { name: "給我 3 個方向" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("沒有開出方向：");
  });
});

describe("DivergeMarker and CompareTable (D3)", () => {
  it("lists the directions; picks two to compare; the table scores them; one press writes the decision", async () => {
    const { client, wrapper } = setup();
    const anchor = await lastReply(client);
    await client.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 3 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const onEnter = vi.fn();
    render(<LiveMarker anchorMessageId={anchor.id} onEnter={onEnter} />, { wrapper });
    const marker = await screen.findByRole("region", { name: "發散：3 個方向" });
    await userEvent.click(within(marker).getByRole("button", { name: "前往「Direction 1 (fake runner)」" }));
    expect(onEnter).toHaveBeenCalled();
    const compare = within(marker).getByRole("button", { name: "比較 0 條" });
    expect(compare).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(marker).getByRole("checkbox", { name: "比較「Direction 1 (fake runner)」" }));
    await userEvent.click(within(marker).getByRole("checkbox", { name: "比較「Direction 2 (fake runner)」" }));
    await userEvent.type(within(marker).getByRole("textbox", { name: /^條件/ }), "安全{Enter}速度");
    await userEvent.click(within(marker).getByRole("button", { name: "比較 2 條" }));
    const table = await within(marker).findByRole("table", { name: "比較表" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["條件", "Direction 1 (fake runner)", "Direction 2 (fake runner)"]);
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["安全", "速度"]);
    expect(within(table).getAllByRole("cell")[0]).toHaveTextContent("5");
    expect(within(marker).getByText("建議：Direction 1 (fake runner)")).toBeInTheDocument();
    const choose = within(marker).getByRole("radiogroup", { name: "決定採用" });
    expect(within(choose).getByRole("radio", { name: "Direction 1 (fake runner)（建議）" })).toBeChecked();
    await userEvent.click(within(marker).getByRole("button", { name: "產生「決定」收尾" }));
    expect(await within(marker).findByText("決定：Direction 1 (fake runner)")).toBeInTheDocument();
    expect(within(marker).getByText("其他 1 條以「未帶回」收尾。")).toBeInTheDocument();
    const outline = (await client.listBranches(NAS_ROOT_ID)).branches;
    expect(outline.find((branch) => branch.purpose === "Direction 2 (fake runner)")?.status).toBe("discarded");
  });

  it("a viewer reads the directions and the table but cannot compare or decide", async () => {
    const { client, wrapper } = setup({ readOnly: true });
    const anchor = await lastReply(client);
    await client.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const options = (await client.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge").map((branch) => branch.lineId);
    await client.converge(NAS_ROOT_ID, { lineIds: options });
    await new Promise((resolve) => setTimeout(resolve, 30));
    render(<LiveMarker anchorMessageId={anchor.id} onEnter={vi.fn()} />, { wrapper });
    const marker = await screen.findByRole("region", { name: "發散：2 個方向" });
    expect(await within(marker).findByRole("table", { name: "比較表" })).toBeInTheDocument();
    await waitFor(() => expect(within(marker).queryByRole("checkbox")).toBeNull());
    expect(within(marker).queryByRole("button", { name: /^比較/ })).toBeNull();
    expect(within(marker).queryByRole("button", { name: "產生「決定」收尾" })).toBeNull();
  });
});

/** Two ready comparisons of the same three directions: (1, 2) and (1, 3). */
async function twoComparisons(client: ReturnType<typeof setup>["client"]) {
  const anchor = await lastReply(client);
  await client.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 3 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const options = (await client.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge").map((branch) => branch.lineId);
  const first = await client.converge(NAS_ROOT_ID, { lineIds: [options[0]!, options[1]!] });
  const second = await client.converge(NAS_ROOT_ID, { lineIds: [options[0]!, options[2]!] });
  await new Promise((resolve) => setTimeout(resolve, 30));
  return [(await client.getComparison(first.comparison.id)).comparison, (await client.getComparison(second.comparison.id)).comparison] as const;
}

describe("CompareTable: the decision's local state (R11)", () => {
  it("J1: another comparison starts afresh: its recommendation chosen, the line empty", async () => {
    const { client, wrapper } = setup();
    const [first, second] = await twoComparisons(client);
    const view = render(<CompareTable lineId={NAS_ROOT_ID} comparison={first} />, { wrapper });
    await userEvent.click(screen.getByRole("radio", { name: "Direction 2 (fake runner)" }));
    await userEvent.type(screen.getByRole("textbox", { name: /^決定的一句話/ }), "選 2");
    view.rerender(<CompareTable lineId={NAS_ROOT_ID} comparison={second} />);
    expect(screen.getByRole("radio", { name: "Direction 1 (fake runner)（建議）" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: /^決定的一句話/ })).toHaveValue("");
  });

  it("J2: after the decision is written, the button stays locked until the decided view shows", async () => {
    const { client, wrapper } = setup();
    const [first] = await twoComparisons(client);
    const decide = vi.spyOn(client, "decideComparison");
    render(<CompareTable lineId={NAS_ROOT_ID} comparison={first} />, { wrapper });
    const button = screen.getByRole("button", { name: "產生「決定」收尾" });
    await userEvent.click(button);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "true"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

describe("FoldBlock: 改摘要 (PATCH /folds/{fid})", () => {
  it("edits the summary in place: Enter-free textarea, 儲存 saves, Esc cancels", async () => {
    const { client, wrapper } = setup();
    const chat = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat");
    const made = await client.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "AI 的" });
    render(<FoldBlock lineId={NAS_ROOT_ID} fold={made.fold} range={{ from: 1, to: 2 }} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "改摘要" }));
    const field = screen.getByRole("textbox", { name: "摘要" });
    expect(field).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "摘要" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "改摘要" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "摘要" }));
    await userEvent.type(screen.getByRole("textbox", { name: "摘要" }), "我的摘要");
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(async () => expect((await client.listFolds(NAS_ROOT_ID)).folds[0]).toMatchObject({ summary: "我的摘要", aiDrafted: false }));
  });
});
