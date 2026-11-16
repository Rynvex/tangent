// @vitest-environment jsdom
import { TangentError, type TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationList } from "./conversation-list";
import { collapsedFolders } from "./f13-prefs";
import FolderTagsPopover from "./folder-tags-popover";
import ImportDialog from "./import-dialog";
import { createPinnedStore } from "./pinned-roots";

/** F13 S1 (folders, #tag filter, pills), S2 (import) and S5 (folder and tags) in the demo frame. */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  window.localStorage.clear();
  collapsedFolders.set("家用設備", false);
});

function wrap(readOnly = false, adapt: (client: TangentClient) => TangentClient = (client) => client) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  mocks.push(client);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const served = adapt(client as TangentClient);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={served} locale="zh-TW" readOnly={readOnly}>
        <ShortcutsProvider>{children}</ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

const noPins = createPinnedStore(() => null);

describe("S1 the list's folders and #tag filter", () => {
  it("groups folders above the time groups, shows tag pills, and collapses a folder", async () => {
    const { wrapper } = wrap();
    render(<ConversationList current={null} onSelect={() => undefined} onNew={() => undefined} onDelete={() => undefined} pinned={noPins} onImport={() => undefined} />, { wrapper });
    const folder = await screen.findByRole("region", { name: "家用設備" });
    expect(folder).toHaveTextContent("家用 NAS 與備份策略");
    expect(within(folder).getByLabelText("標籤：#nas #zfs #備份")).toHaveTextContent("#nas#zfs+1");
    expect(screen.getByRole("region", { name: "旅行" })).toHaveTextContent("日本行程");
    // The archived Proxmox conversation keeps 家用設備 listed; it counts only the active one.
    expect(within(folder).getByRole("button", { name: /^家用設備/ })).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(within(folder).getByRole("button", { name: /^家用設備/ }));
    expect(within(folder).queryByText("家用 NAS 與備份策略")).toBeNull();
    expect(screen.getByRole("button", { name: "匯入對話" })).toBeInTheDocument();
  });

  it("filters by one tag (tenant-wide counts), with a banner that clears it", async () => {
    const { wrapper } = wrap();
    render(<ConversationList current={null} onSelect={() => undefined} onNew={() => undefined} onDelete={() => undefined} pinned={noPins} />, { wrapper });
    const chips = await screen.findByRole("radiogroup", { name: "依標籤篩選" });
    expect(within(chips).getAllByRole("radio").map((chip) => chip.textContent)).toEqual(["全部", "#nas(1)", "#rust(1)", "#zfs(1)", "#備份(1)", "#日本(1)"]);
    await userEvent.click(within(chips).getByRole("radio", { name: "#rust(1)" }));
    expect(await screen.findByText("篩選標籤：#rust（1 篇）")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("家用 NAS 與備份策略")).toBeNull());
    expect(screen.getByRole("region", { name: "未分類" })).toHaveTextContent("學習 Rust 的所有權與借用");
    fireEvent.keyDown(within(chips).getByRole("radio", { name: "#rust(1)" }), { key: "ArrowLeft" });
    expect(await screen.findByText("篩選標籤：#nas（1 篇）")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(await screen.findByText("家用 NAS 與備份策略")).toBeInTheDocument();
  });

  it("B18.1: counts every conversation of the tenant, not the loaded page, and keeps the other tags' counts while one filters", async () => {
    // Two more #nas / #rust conversations in 家用設備 that the first page of GET /lines does not hold (they are on "page two").
    const { client, wrapper } = wrap(false, (served) => ({
      ...served,
      listLines: async (query, opts) => {
        const page = await served.listLines(query, opts);
        return query?.tag || query?.folder || query?.archived ? page : { ...page, lines: page.lines.filter((line) => !line.title.startsWith("Page two")) };
      },
    }));
    for (const title of ["Page two A", "Page two B"]) {
      await client.importConversation({ title, folder: "家用設備", tags: ["nas", "rust"], messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] });
    }
    render(<ConversationList current={null} onSelect={() => undefined} onNew={() => undefined} onDelete={() => undefined} pinned={noPins} />, { wrapper });
    const chips = await screen.findByRole("radiogroup", { name: "依標籤篩選" });
    const labels = () => within(chips).getAllByRole("radio").map((chip) => chip.textContent);
    const tenantWide = ["全部", "#nas(3)", "#rust(3)", "#zfs(1)", "#備份(1)", "#日本(1)"];
    await waitFor(() => expect(labels()).toEqual(tenantWide));
    // The folder counts its three active conversations, though this page shows one of them.
    const folder = screen.getByRole("region", { name: "家用設備" });
    expect(within(folder).getByLabelText("3 篇")).toBeInTheDocument();
    expect(within(folder).queryByText("Page two A")).toBeNull();
    await userEvent.click(within(chips).getByRole("radio", { name: "#rust(3)" }));
    expect(await screen.findByText("篩選標籤：#rust（3 篇）")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("家用 NAS 與備份策略")).toBeNull());
    expect(labels()).toEqual(tenantWide);
  });

  it("removes a folder from its menu (conversations become unfiled) and hides write actions from a viewer", async () => {
    const { client, wrapper } = wrap();
    const toast = vi.fn();
    render(<ConversationList current={null} onSelect={() => undefined} onNew={() => undefined} onDelete={() => undefined} pinned={noPins} toast={toast} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "資料夾「旅行」的動作" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /解散資料夾/ }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("已解散「旅行」，1 篇對話移回未分類"));
    expect((await client.getLine("osaka")).folder).toBe("");
    cleanup();
    const viewer = wrap(true);
    render(<ConversationList current={null} onSelect={() => undefined} onNew={() => undefined} onDelete={() => undefined} pinned={noPins} onImport={() => undefined} />, { wrapper: viewer.wrapper });
    await screen.findByRole("region", { name: "家用設備" });
    expect(screen.queryByRole("button", { name: "匯入對話" })).toBeNull();
    expect(screen.queryByRole("button", { name: /資料夾「家用設備」的動作/ })).toBeNull();
  });
});

describe("S5 folder and tags", () => {
  const anchor = () => document.body;

  it("saves a folder and tags as they change", async () => {
    const { client, wrapper } = wrap();
    render(<FolderTagsPopover lineId="rust" open onOpenChange={() => undefined} anchor={anchor} />, { wrapper });
    const pop = await screen.findByRole("dialog", { name: "資料夾與標籤" });
    await userEvent.click(await within(pop).findByRole("button", { name: "旅行" }));
    await waitFor(async () => expect((await client.getLine("rust")).folder).toBe("旅行"));
    const field = within(pop).getByRole("textbox", { name: "標籤" });
    await userEvent.type(field, "Borrow{Enter}");
    await waitFor(async () => expect((await client.getLine("rust")).tags).toEqual(["rust", "borrow"]));
    expect(within(pop).getByText("2 / 12")).toBeInTheDocument();
    await userEvent.click(within(pop).getByRole("button", { name: "#nas" }));
    await waitFor(async () => expect((await client.getLine("rust")).tags).toEqual(["rust", "borrow", "nas"]));
    await userEvent.click(within(pop).getByRole("button", { name: "新增資料夾" }));
    await userEvent.type(within(pop).getByRole("textbox", { name: "新資料夾名稱" }), "程式語言{Enter}");
    await waitFor(async () => expect((await client.getLine("rust")).folder).toBe("程式語言"));
  });

  it("B18.1: offers the tenant's folders and tags, also those only on conversations the list has not loaded", async () => {
    const { client, wrapper } = wrap(false, (served) => ({
      ...served,
      listLines: async (query, opts) => {
        const page = await served.listLines(query, opts);
        return { ...page, lines: page.lines.filter((line) => line.title !== "Elsewhere") };
      },
    }));
    await client.importConversation({ title: "Elsewhere", folder: "研究", tags: ["topology"], messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] });
    render(<FolderTagsPopover lineId="rust" open onOpenChange={() => undefined} anchor={anchor} />, { wrapper });
    const pop = await screen.findByRole("dialog", { name: "資料夾與標籤" });
    expect(await within(pop).findByRole("button", { name: "研究" })).toBeInTheDocument();
    expect(await within(pop).findByRole("button", { name: "#topology" })).toBeInTheDocument();
  });

  it("puts a change back and says why when it is not saved", async () => {
    const { client, wrapper } = wrap();
    vi.spyOn(client, "updateLine").mockRejectedValue(new TangentError(400, "nope", "invalid_input", { field: "tags" }));
    render(<FolderTagsPopover lineId={NAS_ROOT_ID} open onOpenChange={() => undefined} anchor={anchor} />, { wrapper });
    const pop = await screen.findByRole("dialog", { name: "資料夾與標籤" });
    await userEvent.click(await within(pop).findByRole("button", { name: "移除 #zfs" }));
    expect(await within(pop).findByRole("alert")).toHaveTextContent("沒有存到");
    expect(within(pop).getByRole("button", { name: "移除 #zfs" })).toBeInTheDocument();
  });
});

describe("S2 import (F14: one conversation still goes through F13's form via 快速匯入單篇)", () => {
  it("reads a pasted transcript, lets roles switch and messages go, and imports without branches", async () => {
    const { client, wrapper } = wrap();
    const onImported = vi.fn();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={onImported} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /貼上對話文字/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "對話文字" }), { target: { value: "User: What is ZFS?\nAssistant: A filesystem.\nUser: Thanks\nAssistant: You are welcome." } });
    // The only conversation is checked by itself; one checked can take the quick single form.
    expect(await within(dialog).findByRole("checkbox", { name: "What is ZFS?" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "快速匯入單篇" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "移除 #4" }));
    expect(within(dialog).getByText("3 則・0 條支線・不呼叫模型")).toBeInTheDocument();
    await userEvent.click(within(dialog).getAllByRole("button", { name: /切換角色/ })[2]!);
    await userEvent.click(within(dialog).getByRole("button", { name: "純匯入" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    const [outcome] = onImported.mock.calls[0]!;
    expect(outcome).toMatchObject({ decompose: false, assembled: false, toast: "已匯入「What is ZFS?」" });
    const messages = (await client.listMessages(outcome.focusLineId)).messages;
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "What is ZFS?"],
      ["assistant", "A filesystem."],
      ["assistant", "Thanks"],
    ]);
  });

  it("refuses a file over 20 MB before reading it, and an unknown file with the supported formats", async () => {
    const { wrapper } = wrap();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const big = new File(["x"], "conversations.json", { type: "application/json" });
    Object.defineProperty(big, "size", { value: 20_000_001 });
    const text = vi.spyOn(big, "text");
    fireEvent.change(input, { target: { files: [big] } });
    expect(await within(dialog).findByText("「conversations.json」超過 20 MB，沒有讀取。請在原服務只匯出需要的對話。")).toBeInTheDocument();
    expect(text).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [new File([JSON.stringify({ hello: 1 })], "x.json", { type: "application/json" })] } });
    expect(await within(dialog).findByText(/「x\.json」讀不懂/)).toBeInTheDocument();
  });

  it("lists a ChatGPT file's conversations newest first and restores the checked one's regenerated reply as a branch", async () => {
    const { client, wrapper } = wrap();
    const onImported = vi.fn();
    const node = (id: string, parent: string | null, children: string[], role?: string, text?: string) => ({
      id,
      parent,
      children,
      message: role ? { author: { role }, content: { content_type: "text", parts: [text] }, metadata: {} } : null,
    });
    const conversation = (title: string, update: number) => ({
      title,
      update_time: update,
      current_node: "a2",
      mapping: { r: node("r", null, ["q"]), q: node("q", "r", ["a1", "a2"], "user", `${title}?`), a1: node("a1", "q", [], "assistant", "old answer"), a2: node("a2", "q", [], "assistant", "new answer") },
    });
    render(<ImportDialog open onOpenChange={() => undefined} onImported={onImported} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    const file = new File([JSON.stringify([conversation("Older", 1_700_000_000), conversation("Newer", 1_700_000_100)])], "conversations.json", { type: "application/json" });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    expect(await within(dialog).findByText("ChatGPT・2 篇")).toBeInTheDocument();
    const rows = within(dialog).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"));
    expect(rows).toEqual(["Newer", "Older"]);
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Newer" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "快速匯入單篇" }));
    expect(await within(dialog).findByRole("checkbox", { name: /把 1 個重問／重新生成還原成「另一條路」支線/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "匯入並開啟拆解建議" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    const [outcome] = onImported.mock.calls[0]!;
    expect(outcome.decompose).toBe(true);
    expect((await client.listBranches(outcome.focusLineId)).branches).toEqual([expect.objectContaining({ origin: "import", purpose: "（重新生成）Newer?", status: "discarded" })]);
  });
});
