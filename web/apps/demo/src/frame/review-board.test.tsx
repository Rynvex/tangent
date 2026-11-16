// @vitest-environment jsdom
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrefsStorage } from "./prefs";
import { ReviewBoard } from "./review-board";

afterEach(cleanup);

function memory(): PrefsStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

function setup() {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  const props = { onClose: vi.fn(), navigate: vi.fn(), onFlow: vi.fn(), onExpandSeed: vi.fn() };
  const storage = memory();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="zh-TW">
        <ShortcutsProvider platform="other" target="window">
          <ReviewBoard rootLineId={NAS_ROOT_ID} storage={storage} {...props} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { client, storage, ...props };
}

const column = (name: RegExp) => screen.findByRole("region", { name });

describe("ReviewBoard (C5: four columns, each item ends, snoozes or continues)", () => {
  it("shows the four columns of this conversation with how many are left", async () => {
    setup();
    const board = await screen.findByRole("region", { name: "回顧：還沒收尾的事" });
    expect(await within(board).findByText("剩 6 項")).toBeInTheDocument();
    expect(within(await column(/^開著太久的支線/)).getByRole("article", { name: "改用雲端備份（Backblaze B2），NAS 只做本地快取" })).toBeInTheDocument();
    expect(within(await column(/^待確認的紀要/)).getByRole("article", { name: "ECC 記憶體是否必要" })).toBeInTheDocument();
    expect(within(await column(/^停車場的種子/)).getAllByRole("article")).toHaveLength(3);
    expect(within(await column(/^未處理的建議/)).getAllByRole("article")).toHaveLength(1);
  });

  it("snoozes an item in this browser only, and can bring it back", async () => {
    const { storage } = setup();
    const seeds = await column(/^停車場的種子/);
    const ups = await within(seeds).findByRole("article", { name: "UPS 要不要買？" });
    await userEvent.click(within(ups).getByRole("button", { name: "暫存" }));
    await waitFor(() => expect(within(seeds).queryByRole("article", { name: "UPS 要不要買？" })).toBeNull());
    expect(await screen.findByText("剩 5 項")).toBeInTheDocument();
    expect(Object.keys(JSON.parse(storage.data["tangent-demo.review-snoozes"] ?? "{}"))).toEqual(["seeds:nas-s1"]);
    await userEvent.click(screen.getByRole("button", { name: "顯示暫存的（1）" }));
    const back = await within(seeds).findByRole("article", { name: "UPS 要不要買？" });
    await userEvent.click(within(back).getByRole("button", { name: "取消暫存" }));
    expect(await screen.findByText("剩 6 項")).toBeInTheDocument();
  });

  it("ends items: drops a seed, dismisses a suggestion, confirms a note", async () => {
    const { client } = setup();
    const seeds = await column(/^停車場的種子/);
    await userEvent.click(within(await within(seeds).findByRole("article", { name: "UPS 要不要買？" })).getByRole("button", { name: "丟掉" }));
    await waitFor(async () => expect((await client.listSeeds(NAS_ROOT_ID)).seeds.map((seed) => seed.id)).not.toContain("nas-s1"));
    const suggestions = await column(/^未處理的建議/);
    await userEvent.click(within(within(suggestions).getByRole("article")).getByRole("button", { name: "忽略" }));
    await waitFor(async () => expect((await client.listSuggestions(NAS_ROOT_ID)).suggestions).toHaveLength(0));
    const notes = await column(/^待確認的紀要/);
    await userEvent.click(within(within(notes).getByRole("article")).getByRole("button", { name: "已確認" }));
    await waitFor(async () => expect((await client.listNotes(NAS_ROOT_ID)).notes.find((note) => note.id === "n5")?.section).toBe("fact"));
    expect(await screen.findByText("剩 3 項")).toBeInTheDocument();
  });

  it("continues: a stale branch goes there, a seed expands, a branch ends through its conclusion card", async () => {
    const { navigate, onFlow, onExpandSeed, onClose } = setup();
    const stale = within(await (await column(/^開著太久的支線/)).querySelector("article")!.closest("article")!);
    await userEvent.click(stale.getByRole("button", { name: "繼續" }));
    expect(navigate).toHaveBeenCalledWith("nas-b2", undefined);
    expect(onClose).toHaveBeenCalled();
    await userEvent.click(stale.getByRole("button", { name: "結束" }));
    expect(onFlow).toHaveBeenCalledWith({ kind: "review", lineId: "nas-b2" });
    const seeds = await column(/^停車場的種子/);
    await userEvent.click(within(await within(seeds).findByRole("article", { name: "UPS 要不要買？" })).getByRole("button", { name: "展開成支線" }));
    expect(onExpandSeed).toHaveBeenCalledWith(expect.objectContaining({ id: "nas-s1" }));
  });

  it("switches to every conversation, and Esc closes it", async () => {
    const { client, onClose } = setup();
    await client.createSeed("osaka", { text: "JR Pass？" });
    const scope = await screen.findByRole("radiogroup", { name: "範圍" });
    await userEvent.click(within(scope).getByRole("radio", { name: "所有對話" }));
    expect(await screen.findByRole("article", { name: "JR Pass？" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
