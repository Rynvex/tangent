import { NAS_ROOT_ID } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TangentRoot } from "../root/tangent-root";
import { mockClient, tangentWrapper } from "../test-utils";
import { TurnPreview } from "./turn-preview";

afterEach(cleanup);

describe("TurnPreview", () => {
  it("lists the blocks with tokens, the total, the estimated cost and the line's totals", async () => {
    const client = mockClient();
    render(
      <TangentRoot>
        <TurnPreview open onOpenChange={vi.fn()} lineId={NAS_ROOT_ID} content="UPS?" lineUsage={{ inputTokens: 30_000, outputTokens: 8_300, costUsd: 0.21 }} />
      </TangentRoot>,
      { wrapper: tangentWrapper(client) },
    );
    const dialog = await screen.findByRole("dialog", { name: "Preview before sending" });
    await waitFor(() => expect(within(dialog).getByText("Rules")).toBeInTheDocument());
    expect(within(dialog).getByText(/^Recent messages \(\d+\)$/)).toBeInTheDocument();
    expect(within(dialog).getByText("Your message")).toBeInTheDocument();
    expect(within(dialog).getByText(/^Estimated input cost: US\$/)).toBeInTheDocument();
    expect(within(dialog).getByText("Used on this line so far: 38k tokens · US$0.21")).toBeInTheDocument();

    const row = within(dialog).getByRole("button", { name: /Your message/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText("UPS?")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("says when the server has no price for the model", async () => {
    const client = mockClient();
    const original = client.previewTurn;
    vi.spyOn(client, "previewTurn").mockImplementation(async (...args) => {
      const { estimatedCostUsd: _cost, ...rest } = await original(...args);
      return rest;
    });
    render(
      <TangentRoot>
        <TurnPreview open onOpenChange={vi.fn()} lineId={NAS_ROOT_ID} content="" />
      </TangentRoot>,
      { wrapper: tangentWrapper(client) },
    );
    expect(await screen.findByText("The server has no price for this model.")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("is a non-modal panel on desktop: the page stays usable, the close button and Esc close it (DESIGN §12)", async () => {
    const client = mockClient();
    const onOpenChange = vi.fn();
    render(
      <TangentRoot>
        <textarea aria-label="Draft" />
        <TurnPreview open onOpenChange={onOpenChange} lineId={NAS_ROOT_ID} content="UPS?" mode="panel" />
      </TangentRoot>,
      { wrapper: tangentWrapper(client) },
    );
    const panel = await screen.findByRole("region", { name: "Preview before sending" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(within(panel).getByText("Rules")).toBeInTheDocument());
    // The draft can still be typed while the panel is open.
    await userEvent.type(screen.getByRole("textbox", { name: "Draft" }), "more");
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("more");
    await userEvent.click(within(panel).getByRole("button", { name: /Your message/ }));
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    client.mock.dispose();
  });
});

describe("TurnPreview: the budget and the fisheye (C1, F5 phase 2)", () => {
  function show(client: ReturnType<typeof mockClient>, lineId = NAS_ROOT_ID) {
    render(
      <TangentRoot>
        <TurnPreview open onOpenChange={vi.fn()} lineId={lineId} content="UPS?" />
      </TangentRoot>,
      { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) },
    );
    return screen.findByRole("dialog", { name: "送出前預覽" });
  }

  it("shows how the budget was spent", async () => {
    const client = mockClient();
    const dialog = await show(client);
    const budget = await within(dialog).findByRole("region", { name: "預算分配" });
    expect(budget).toHaveTextContent(/已用 [\d,]+ \/ 40,000 token/);
    expect(within(budget).getByText("最近訊息")).toBeInTheDocument();
    expect(within(budget).getByText("紀要")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("lists what AI sees, item by item: level and score; a pinned message is always sent", async () => {
    const client = mockClient();
    await client.pinMessage("nas-m17");
    const dialog = await show(client);
    const sees = await within(dialog).findByRole("region", { name: "這一輪 AI 看得到什麼" });
    // Names come from the messages and the outline, which load alongside.
    await waitFor(() => expect(sees).toHaveTextContent("用舊筆電當 NAS"));
    await waitFor(() => expect(sees).toHaveTextContent("一定送出"));
    const items = within(sees).getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(3);
    const pinned = items.find((item) => item.textContent?.includes("一定送出"))!;
    expect(pinned).toHaveTextContent("完整");
    // Pinned is +100, minus how many rounds back it is.
    expect(Number(/分數 (-?\d+)/.exec(pinned.textContent ?? "")?.[1])).toBeGreaterThanOrEqual(90);
    expect(items.some((item) => item.textContent?.includes("摘要"))).toBe(true);
    const leaf = items.find((item) => item.textContent?.includes("用舊筆電當 NAS"))!;
    expect(leaf).toHaveTextContent("只有一句收尾");
    // Levels are words, not only colours.
    for (const item of items) expect(item.textContent).toMatch(/完整|摘要|只有一句收尾|看不到/);
    client.mock.dispose();
  });

  it("names a group's item by the group and its shared summary (C2: the group stands for its members)", async () => {
    const client = mockClient({ draftMs: 1 });
    const made = await client.createGroup(NAS_ROOT_ID, { memberLineIds: ["nas-b5", "nas-b4"], title: "硬碟與舊筆電" });
    await waitFor(async () => expect((await client.getGroup(made.group.id)).group.summaryStatus).toBe("ready"));
    const dialog = await show(client);
    const sees = await within(dialog).findByRole("region", { name: "這一輪 AI 看得到什麼" });
    await waitFor(() => expect(sees).toHaveTextContent("群組・硬碟與舊筆電"));
    const item = within(sees).getAllByRole("listitem").find((entry) => entry.textContent?.includes("群組・硬碟與舊筆電"))!;
    expect(item).toHaveTextContent("fake runner");
    client.mock.dispose();
  });

  it("lists the folds the prompt applies (D4), and names a fold's fisheye item by its range", async () => {
    const client = mockClient({ draftMs: 1 });
    const chat = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat");
    await client.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "前兩則的摘要" });
    const dialog = await show(client);
    const folds = await within(dialog).findByRole("region", { name: "折疊" });
    await waitFor(() => expect(within(folds).getByRole("listitem")).toHaveTextContent(/^#1–#2：2 則，送 \d+ token（原本 \d+）$/));
    const sees = await within(dialog).findByRole("region", { name: "這一輪 AI 看得到什麼" });
    await waitFor(() => expect(within(sees).getAllByRole("listitem").some((item) => item.textContent?.includes("折疊 #1–#2") && item.textContent.includes("前兩則的摘要"))).toBe(true));
    client.mock.dispose();
  });

  it("names folds without numbers while the line's messages are not loaded (R11 J7, as FoldBlock does)", async () => {
    const client = mockClient({ draftMs: 1 });
    const chat = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat");
    await client.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "前兩則的摘要" });
    vi.spyOn(client, "listMessages").mockReturnValue(new Promise(() => undefined));
    const dialog = await show(client);
    const folds = await within(dialog).findByRole("region", { name: "折疊" });
    expect(within(folds).getByRole("listitem")).toHaveTextContent(/^2 則，送 \d+ token（原本 \d+）$/);
    const sees = await within(dialog).findByRole("region", { name: "這一輪 AI 看得到什麼" });
    await waitFor(() => expect(within(sees).getAllByRole("listitem").some((item) => item.textContent?.includes("已折疊（2 則）"))).toBe(true));
    expect(dialog).not.toHaveTextContent("#–#");
    client.mock.dispose();
  });

  it("lists the memories this turn recalls across conversations (D1), with their kind and source", async () => {
    const client = mockClient({ draftMs: 1 });
    await client.createMemory({ kind: "decision", text: "UPS 要買 600VA 的", sourceLineId: NAS_ROOT_ID });
    const dialog = await show(client);
    const memories = await within(dialog).findByRole("region", { name: "記憶（跨對話）" });
    expect(within(memories).getByRole("listitem")).toHaveTextContent("決定");
    expect(within(memories).getByRole("listitem")).toHaveTextContent("UPS 要買 600VA 的");
    expect(within(dialog).getByRole("button", { name: /記憶（跨對話）/ })).toBeInTheDocument();
    client.mock.dispose();
  });

  it("has no fisheye part while the feature is off", async () => {
    const scenario = (await import("@tangent/client/testing")).nasScenario();
    scenario.capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "fisheye" ? { name: "fisheye", enabled: false } : feature)) };
    const client = mockClient({ scenario });
    const dialog = await show(client);
    await within(dialog).findByRole("region", { name: "預算分配" });
    expect(within(dialog).queryByRole("region", { name: "這一輪 AI 看得到什麼" })).toBeNull();
    client.mock.dispose();
  });
});
