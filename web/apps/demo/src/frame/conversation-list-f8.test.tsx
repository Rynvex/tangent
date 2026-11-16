// @vitest-environment jsdom
import { TangentError, type TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationList, type ConversationListProps } from "./conversation-list";
import { ConversationMenu } from "./conversation-menu";
import { createPinnedStore, PINNED_ROOTS_KEY, type PinnedStorage } from "./pinned-roots";

/** F8 S5: 置頂, 重新命名 and the list's 回顧 / 記憶庫 footer. */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function memoryStorage(initial: string[] = []): PinnedStorage {
  const data: Record<string, string> = { [PINNED_ROOTS_KEY]: JSON.stringify(initial) };
  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

function setup({ pinned = [], features = "all", props = {} }: { pinned?: string[]; features?: "all" | "c1"; props?: Partial<ConversationListProps> } = {}) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario({ features }) });
  mocks.push(client);
  const store = createPinnedStore(() => memoryStorage(pinned));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client as TangentClient} locale="zh-TW">
        <ShortcutsProvider>{children}</ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>
  );
  render(<ConversationList current={null} onSelect={() => undefined} onNew={() => undefined} onDelete={() => undefined} pinned={store} {...props} />, { wrapper });
  return { client, store };
}

const rowNames = (section: HTMLElement) => within(section).getAllByRole("button", { name: /^(?!「)/ }).map((button) => button.textContent ?? "");
const menuOf = (title: string) => screen.getByRole("button", { name: `「${title}」的動作` });

describe("置頂 (decision #6)", () => {
  it("lists pinned conversations first under 置頂, newest pin first, and not again in their time group", async () => {
    setup({ pinned: ["okr", NAS_ROOT_ID] });
    const group = await screen.findByRole("region", { name: "置頂" });
    const rows = rowNames(group);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^家用 NAS 與備份策略/);
    expect(rows[1]).toMatch(/^週報的 OKR 用語/);
    for (const other of screen.getAllByRole("region").filter((region) => region !== group)) {
      expect(other).not.toHaveTextContent("家用 NAS 與備份策略");
      expect(other).not.toHaveTextContent("週報的 OKR 用語");
    }
  });

  it("shows no 置頂 group when nothing is pinned, and pins from the row's menu", async () => {
    const { store } = setup();
    await screen.findByText("家用 NAS 與備份策略");
    expect(screen.queryByRole("region", { name: "置頂" })).toBeNull();
    await userEvent.click(menuOf("週報的 OKR 用語"));
    const pin = await screen.findByRole("menuitem", { name: /置頂對話/ });
    expect(pin).toHaveTextContent("只在這台裝置");
    await userEvent.click(pin);
    expect(store.get()).toEqual(["okr"]);
    expect(await screen.findByRole("region", { name: "置頂" })).toHaveTextContent("週報的 OKR 用語");
    await userEvent.click(menuOf("週報的 OKR 用語"));
    await userEvent.click(await screen.findByRole("menuitem", { name: /取消置頂/ }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "置頂" })).toBeNull());
  });
});

describe("重新命名 in the list", () => {
  async function startRename(title: string) {
    await userEvent.click(menuOf(title));
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("重新命名…");
    await userEvent.click(items[0]!);
    return screen.findByRole("textbox", { name: `「${title}」的標題` });
  }

  it("Enter saves the new title; the counter shows the length", async () => {
    const { client } = setup();
    await screen.findByText("週報的 OKR 用語");
    const field = await startRename("週報的 OKR 用語");
    expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.type(field, "OKR 詞彙");
    expect(screen.getByText(/6 \/ 200/)).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(async () => expect((await client.getLine("okr")).title).toBe("OKR 詞彙"));
    expect(await screen.findByText("OKR 詞彙")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /的標題/ })).toBeNull();
  });

  it("Esc gives up and leaves the title as it was", async () => {
    const { client } = setup();
    await screen.findByText("週報的 OKR 用語");
    const field = await startRename("週報的 OKR 用語");
    await userEvent.type(field, "XYZ");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect((await client.getLine("okr")).title).toBe("週報的 OKR 用語");
  });

  it("refuses an empty title here, and keeps the typed text with the reason when the server refuses", async () => {
    const { client } = setup();
    await screen.findByText("週報的 OKR 用語");
    const field = await startRename("週報的 OKR 用語");
    await userEvent.clear(field);
    await userEvent.type(field, "   {Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("標題不能空白。");
    vi.spyOn(client, "updateLine").mockRejectedValueOnce(new TangentError(422, "too long", "too_long"));
    await userEvent.clear(field);
    await userEvent.type(field, "新名字{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/沒有改成名稱/);
    expect(field).toHaveValue("新名字");
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  it("does not rename an archived conversation and says why", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: /封存（/ }));
    await userEvent.click(menuOf("Proxmox 叢集規劃"));
    const rename = (await screen.findAllByRole("menuitem"))[0]!;
    expect(rename).toHaveAttribute("aria-disabled", "true");
    expect(rename).toHaveTextContent("封存的對話不能改名。");
  });
});

describe("the list's footer", () => {
  it("shows 回顧 with the 待處理 number and 記憶庫 while memory is on", async () => {
    const onReview = vi.fn();
    const onOpenLibrary = vi.fn();
    setup({ props: { onReview, reviewCount: 4, onOpenLibrary } });
    const review = await screen.findByRole("button", { name: "回顧，4 項待處理" });
    expect(review).toHaveTextContent("4");
    await userEvent.click(review);
    expect(onReview).toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "記憶庫" }));
    expect(onOpenLibrary).toHaveBeenCalled();
  });

  it("leaves 記憶庫 out while memory is off, and the whole footer without handlers", async () => {
    setup({ features: "c1", props: { onReview: () => undefined, reviewCount: 0, onOpenLibrary: () => undefined } });
    expect(await screen.findByRole("button", { name: "回顧" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "記憶庫" })).toBeNull());
    cleanup();
    setup();
    await screen.findByText("週報的 OKR 用語");
    expect(screen.queryByRole("button", { name: /^回顧/ })).toBeNull();
  });
});

describe("ConversationMenu in the header", () => {
  it("opens its own rename dialog, and offers search and export when given", async () => {
    const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
    mocks.push(client);
    const line = await client.getLine(NAS_ROOT_ID);
    const onSearch = vi.fn();
    const onExport = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TangentProvider client={client as TangentClient} locale="zh-TW">
          <ShortcutsProvider>
            <ConversationMenu line={line} onDelete={() => undefined} onSearchInTree={onSearch} onExport={onExport} pinned={createPinnedStore(() => null)} />
          </ShortcutsProvider>
        </TangentProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(menuOf("家用 NAS 與備份策略"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.replace(/⌘|Ctrl|\+|F$/g, "").trim())).toEqual(["重新命名…", "置頂對話只在這台裝置", "資料夾與標籤…新", "在對話內搜尋", "匯出…", "封存對話", "刪除對話…"]);
    await userEvent.click(items[4]!);
    expect(onExport).toHaveBeenCalled();
    await userEvent.click(menuOf("家用 NAS 與備份策略"));
    await userEvent.click((await screen.findAllByRole("menuitem"))[0]!);
    const dialog = await screen.findByRole("dialog", { name: "重新命名對話" });
    const field = within(dialog).getByRole("textbox");
    await userEvent.clear(field);
    await userEvent.type(field, "NAS 計畫");
    await userEvent.click(within(dialog).getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await client.getLine(NAS_ROOT_ID)).title).toBe("NAS 計畫");
  });
});
