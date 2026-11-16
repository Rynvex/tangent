// @vitest-environment jsdom
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary } from "./memory-library";

afterEach(cleanup);

type MockClient = ReturnType<typeof createMockTangentClient>;

/** `newer` facts are written after the three memories, so with 99 the ZFS ones are on the second page (100 a page). */
async function setup({ readOnly = false, newer = 0, wrap = (client: MockClient) => client, then = async (_client: MockClient) => {} } = {}) {
  const scenario = nasScenario();
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = wrap(createMockTangentClient({ latencyMs: 0, scenario }));
  const old = await client.createMemory({ kind: "decision", text: "The NAS uses a ZFS mirror", importance: 8, sourceLineId: NAS_ROOT_ID });
  await client.supersedeMemory(old.memory.id, { text: "The NAS uses ZFS RAIDZ1" });
  await client.createMemory({ kind: "preference", text: "Quiet fans for the server" });
  for (let n = 1; n <= newer; n += 1) await client.createMemory({ kind: "fact", text: `Fact ${n}` });
  await then(client);
  const props = { onClose: vi.fn(), navigate: vi.fn() };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="zh-TW">
        <ShortcutsProvider platform="other" target="window">
          <Host {...props} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "打開記憶庫" }));
  const page = await screen.findByRole("dialog", { name: "記憶庫" });
  return { client, page, ...props };
}

/** As the shell: a button opens it; closing unmounts it. */
function Host({ onClose, navigate }: { onClose: () => void; navigate: (lineId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打開記憶庫
      </button>
      {open && (
        <MemoryLibrary
          navigate={navigate}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

const card = (page: HTMLElement, text: string) => within(page).getByRole("article", { name: text });
const cards = (page: HTMLElement) => within(within(page).getByRole("group", { name: "記憶清單" })).queryAllByRole("article");
const PAGE_BOTTOM_NEWER = 99;

describe("MemoryLibrary (D1, components.md: main + side, gap 16; filters, replaced history)", () => {
  it("lists the memories with kind, importance, source and what each replaced; filters by kind", async () => {
    const { page, navigate, onClose } = await setup();
    const zfs = await within(page).findByRole("article", { name: "The NAS uses ZFS RAIDZ1" });
    expect(zfs).toHaveTextContent("決定");
    expect(zfs).toHaveTextContent("重要性 8");
    expect(within(zfs).getByText("The NAS uses a ZFS mirror").tagName).toBe("S");
    expect(zfs).toHaveTextContent("被這條取代");
    const filter = within(page).getByRole("radiogroup", { name: "種類" });
    await userEvent.click(within(filter).getByRole("radio", { name: "偏好" }));
    await waitFor(() => expect(within(page).queryByRole("article", { name: "The NAS uses ZFS RAIDZ1" })).toBeNull());
    expect(card(page, "Quiet fans for the server")).toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "載入更多" })).toBeNull();
    await userEvent.click(within(filter).getByRole("radio", { name: "全部" }));
    await within(page).findByRole("article", { name: "The NAS uses ZFS RAIDZ1" });
    await userEvent.click(within(card(page, "The NAS uses ZFS RAIDZ1")).getByRole("button", { name: /^出處：/ }));
    expect(navigate).toHaveBeenCalledWith(NAS_ROOT_ID);
    expect(onClose).toHaveBeenCalled();
  });

  it("B10.1: 載入更多 appends the next page and moves focus to its first card; gone on the last page; a filter starts from page one", async () => {
    const { page } = await setup({ newer: PAGE_BOTTOM_NEWER });
    const more = await within(page).findByRole("button", { name: "載入更多" });
    expect(cards(page)).toHaveLength(100);
    expect(within(page).queryByRole("article", { name: "The NAS uses ZFS RAIDZ1" })).toBeNull();
    await userEvent.click(more);
    const zfs = await within(page).findByRole("article", { name: "The NAS uses ZFS RAIDZ1" });
    expect(cards(page)).toHaveLength(101);
    expect(cards(page)[0]).toHaveAccessibleName(`Fact ${PAGE_BOTTOM_NEWER}`);
    expect(within(zfs).getByText("The NAS uses a ZFS mirror").tagName).toBe("S");
    await waitFor(() => expect(zfs).toHaveFocus());
    expect(within(page).queryByRole("button", { name: "載入更多" })).toBeNull();
    await userEvent.click(within(within(page).getByRole("radiogroup", { name: "種類" })).getByRole("radio", { name: "決定" }));
    await waitFor(() => expect(cards(page).map((item) => item.getAttribute("aria-label"))).toEqual(["The NAS uses ZFS RAIDZ1"]));
    expect(within(page).queryByRole("button", { name: "載入更多" })).toBeNull();
  });

  it("B10.1 review: a card on page one shows what it replaced even when that is old and of another kind", async () => {
    const { page } = await setup({
      newer: PAGE_BOTTOM_NEWER,
      then: async (client) => {
        const fans = (await client.listMemories({ kind: "preference" })).memories[0]!;
        await client.supersedeMemory(fans.id, { text: "Fans under 20 dB", kind: "lesson" });
      },
    });
    const quiet = await within(page).findByRole("article", { name: "Fans under 20 dB" });
    expect(cards(page)[0]).toBe(quiet);
    await waitFor(() => expect(within(quiet).getByText("Quiet fans for the server").tagName).toBe("S"));
    expect(cards(page)).toHaveLength(100);
    expect(within(page).queryByRole("article", { name: "Quiet fans for the server" })).toBeNull();
    await userEvent.click(within(within(page).getByRole("radiogroup", { name: "種類" })).getByRole("radio", { name: "教訓" }));
    await waitFor(() => expect(cards(page).map((item) => item.getAttribute("aria-label"))).toEqual(["Fans under 20 dB"]));
    expect(within(card(page, "Fans under 20 dB")).getByText("Quiet fans for the server").tagName).toBe("S");
    expect(within(page).queryByRole("button", { name: "載入更多" })).toBeNull();
  });

  it("B10.1 review: a page still loading when the filter changes does not move focus", async () => {
    let release = () => {};
    let held = false;
    const { page } = await setup({
      newer: PAGE_BOTTOM_NEWER,
      wrap: (client) => {
        const list = client.listMemories.bind(client);
        client.listMemories = (query = {}, opts) => {
          if (!query.cursor || held) return list(query, opts);
          held = true;
          return new Promise((resolve, reject) => {
            release = () => void list(query, opts).then(resolve, reject);
          });
        };
        return client;
      },
    });
    const kinds = within(page).getByRole("radiogroup", { name: "種類" });
    const decisions = within(kinds).getByRole("radio", { name: "決定" });
    const all = within(kinds).getByRole("radio", { name: "全部" });
    // 決定 is in the cache, so switching back to it shows its card at once.
    await userEvent.click(decisions);
    await waitFor(() => expect(cards(page).map((item) => item.getAttribute("aria-label"))).toEqual(["The NAS uses ZFS RAIDZ1"]));
    await userEvent.click(all);
    await userEvent.click(await within(page).findByRole("button", { name: "載入更多" }));
    await userEvent.click(decisions);
    await waitFor(() => expect(cards(page)).toHaveLength(1));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decisions).toHaveFocus();
    await userEvent.click(all);
    await waitFor(() => expect(cards(page)).toHaveLength(100));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(all).toHaveFocus();
  });

  it("B10.1: a page that fails to load says why under the button, keeps focus there, and loads on the next try", async () => {
    let failNext = true;
    const { page } = await setup({
      newer: PAGE_BOTTOM_NEWER,
      wrap: (client) => {
        const list = client.listMemories.bind(client);
        client.listMemories = (query = {}, opts) => {
          if (query.cursor && failNext) {
            failNext = false;
            return Promise.reject(new Error("offline"));
          }
          return list(query, opts);
        };
        return client;
      },
    });
    const more = await within(page).findByRole("button", { name: "載入更多" });
    await userEvent.click(more);
    expect(await within(page).findByRole("alert")).toHaveTextContent("沒有載入更多");
    expect(more).toHaveFocus();
    expect(cards(page)).toHaveLength(100);
    await userEvent.click(more);
    await within(page).findByRole("article", { name: "The NAS uses ZFS RAIDZ1" });
    expect(within(page).queryByRole("alert")).toBeNull();
  });

  it("adds a memory, changes its importance, and replaces its text (the old one goes to its history)", async () => {
    const { page } = await setup();
    const add = within(page).getByRole("form", { name: "新增記憶" });
    await userEvent.selectOptions(within(add).getByRole("combobox", { name: "種類" }), "lesson");
    await userEvent.type(within(add).getByRole("textbox", { name: "內容" }), "Test the restores");
    await userEvent.click(within(add).getByRole("button", { name: "記住" }));
    const lesson = await within(page).findByRole("article", { name: "Test the restores" });
    await userEvent.selectOptions(within(lesson).getByRole("combobox", { name: "重要性" }), "9");
    await waitFor(() => expect(card(page, "Test the restores")).toHaveTextContent("重要性 9"));
    await userEvent.click(within(card(page, "Test the restores")).getByRole("button", { name: "取代…" }));
    const field = within(card(page, "Test the restores")).getByRole("textbox", { name: "新的內容" });
    await userEvent.type(field, "Test the restores every month");
    await userEvent.click(within(card(page, "Test the restores")).getByRole("button", { name: "取代" }));
    const replaced = await within(page).findByRole("article", { name: "Test the restores every month" });
    expect(within(replaced).getByText("Test the restores").tagName).toBe("S");
  });

  it("searches like a new conversation would; a viewer only reads", async () => {
    const first = await setup();
    await userEvent.type(within(first.page).getByRole("searchbox", { name: "搜尋記憶" }), "Which ZFS for the NAS?");
    const results = await within(first.page).findByRole("list", { name: "搜尋結果" });
    expect(await within(results).findByText("The NAS uses ZFS RAIDZ1")).toBeInTheDocument();
    cleanup();
    const viewer = await setup({ readOnly: true });
    await within(viewer.page).findByRole("article", { name: "The NAS uses ZFS RAIDZ1" });
    expect(within(viewer.page).queryByRole("form", { name: "新增記憶" })).toBeNull();
    expect(within(viewer.page).queryByRole("button", { name: "取代…" })).toBeNull();
  });

  it("is a modal dialog (R11 J6): focus moves in, Tab stays inside, Esc closes and focus returns to the button", async () => {
    const { page, onClose } = await setup();
    expect(page).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(page).toContainElement(document.activeElement as HTMLElement));
    for (let step = 0; step < 30; step += 1) {
      await userEvent.tab();
      // Base UI's focus guards hand focus back inside on their own focus event.
      await waitFor(() => expect(page).toContainElement(document.activeElement as HTMLElement));
    }
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "記憶庫" })).toBeNull());
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "打開記憶庫" })).toHaveFocus());
  });
});
