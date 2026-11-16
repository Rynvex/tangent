/** F6 phase 3 (D1): the recall at a new conversation and in the branch form, and the notes' memory footer. */
import type { Capabilities } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useTangentEvents } from "../data/live-hooks";
import { mockClient, tangentWrapper } from "../test-utils";
import { BranchMemoryRecall } from "./branch-memory-recall";
import { MemoryFooter } from "./memory-footer";
import { MemoryRecall } from "./memory-recall";

afterEach(cleanup);

/** Keeps the cache live with the mock's events, as a host does. */
function Live({ children }: { children: ReactNode }) {
  useTangentEvents();
  return <>{children}</>;
}
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup({ off = false }: { off?: boolean } = {}) {
  const scenario = nasScenario();
  if (off) scenario.capabilities = { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "memory" ? { name: "memory", enabled: false } : feature)) } satisfies Capabilities;
  const client = mockClient({ scenario, draftMs: 5 });
  clients.push(client);
  return { client, wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) };
}

describe("MemoryRecall (D1, components.md: dashed card p 12; prompt, brought in, dismissed)", () => {
  it("shows what was concluded before about the first message; 帶入 hands the host a block to put in the message", async () => {
    const { client, wrapper } = setup();
    await client.createMemory({ kind: "decision", text: "The NAS uses a ZFS mirror", sourceLineId: NAS_ROOT_ID });
    const onUse = vi.fn();
    render(<MemoryRecall query="Which ZFS layout for the NAS?" onUse={onUse} />, { wrapper });
    const card = await screen.findByRole("region", { name: "你之前得出過" });
    expect(card).toHaveTextContent("決定");
    expect(card).toHaveTextContent("The NAS uses a ZFS mirror");
    expect(card).toHaveTextContent("出處：");
    expect(document.activeElement).toBe(document.body);
    await userEvent.click(within(card).getByRole("button", { name: "帶入這 1 條" }));
    expect(onUse).toHaveBeenCalledWith("之前得出過：\n- [決定] The NAS uses a ZFS mirror");
    expect(await screen.findByText("已在訊息開頭帶入 1 條，會出現在送出前預覽。")).toBeInTheDocument();
  });

  it("忽略 removes it; nothing related, or the feature off, shows nothing", async () => {
    const { client, wrapper } = setup();
    await client.createMemory({ kind: "fact", text: "The NAS uses a ZFS mirror" });
    const { rerender } = render(<MemoryRecall query="ZFS for the NAS?" onUse={vi.fn()} />, { wrapper });
    const card = await screen.findByRole("region", { name: "你之前得出過" });
    await userEvent.click(within(card).getByRole("button", { name: "忽略" }));
    expect(screen.queryByRole("region", { name: "你之前得出過" })).toBeNull();
    rerender(<MemoryRecall query="Holiday in Osaka" onUse={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: "你之前得出過" })).toBeNull();
    cleanup();
    const off = setup({ off: true });
    render(<MemoryRecall query="ZFS for the NAS?" onUse={vi.fn()} />, { wrapper: off.wrapper });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("BranchMemoryRecall (in the branch form: tick what to bring in)", () => {
  it("ticked memories become the block to add to the branch's background", async () => {
    const { client, wrapper } = setup();
    await client.createMemory({ kind: "lesson", text: "Test restores, not only backups" });
    const onChange = vi.fn();
    render(<BranchMemoryRecall purpose="How often to test restores of the backups" onChange={onChange} />, { wrapper });
    const group = await screen.findByRole("group", { name: "帶入之前得出過的" });
    const box = within(group).getByRole("checkbox", { name: "帶入「Test restores, not only backups」" });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith("之前得出過：\n- [教訓] Test restores, not only backups");
    await userEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("a ticked memory stays listed (and can be unticked) after the purpose changes and the search no longer finds it (R11 J1 sweep)", async () => {
    const { client, wrapper } = setup();
    await client.createMemory({ kind: "lesson", text: "Test restores, not only backups" });
    await client.createMemory({ kind: "preference", text: "Quiet fans for the server rack" });
    const onChange = vi.fn();
    const view = render(<BranchMemoryRecall purpose="How often to test restores of the backups" onChange={onChange} />, { wrapper });
    const group = await screen.findByRole("group", { name: "帶入之前得出過的" });
    await userEvent.click(within(group).getByRole("checkbox", { name: "帶入「Test restores, not only backups」" }));
    view.rerender(<BranchMemoryRecall purpose="Which quiet fans for the server rack" onChange={onChange} />);
    await screen.findByRole("checkbox", { name: "帶入「Quiet fans for the server rack」" }, { timeout: 3000 });
    const kept = screen.getByRole("checkbox", { name: "帶入「Test restores, not only backups」" });
    expect(kept).toBeChecked();
    await userEvent.click(kept);
    expect(onChange).toHaveBeenLastCalledWith("");
  });
});

describe("MemoryFooter (D1, components.md: dashed box p 10/12; brought in, none)", () => {
  it("lists what the next turn brings in, apart from the notes, and leads to the library", async () => {
    const { client, wrapper } = setup();
    const onOpenLibrary = vi.fn();
    render(
      <Live>
        <MemoryFooter lineId={NAS_ROOT_ID} onOpenLibrary={onOpenLibrary} />
      </Live>,
      { wrapper },
    );
    const footer = await screen.findByRole("region", { name: "跨對話記憶" });
    expect(await within(footer).findByText("這一輪沒有帶入記憶。")).toBeInTheDocument();
    expect(footer).toHaveTextContent("不屬於這段對話");
    await userEvent.click(within(footer).getByRole("button", { name: "記憶庫" }));
    expect(onOpenLibrary).toHaveBeenCalled();
    const title = (await client.getLine(NAS_ROOT_ID)).title;
    // A new memory (memory.changed) reloads the preview the footer reads.
    await client.createMemory({ kind: "fact", text: title });
    await waitFor(() => expect(screen.getByRole("region", { name: "跨對話記憶" })).toHaveTextContent(title));
  });
});
