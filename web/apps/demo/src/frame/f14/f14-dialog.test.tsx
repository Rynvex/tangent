// @vitest-environment jsdom
/** F14 in the demo frame: S1 several files, search and picks; S2 order and the peek; S3 modes, roles and cards; S4 importing. */
import { TangentError, type Capabilities, type TangentClient } from "@tangent/client";
import { createMockTangentClient, geminiCombinedSample, longCombinedExport, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImportDialog from "../import-dialog";

// Vitest runs from apps/demo; the e2e fixtures are the same files the browser test uploads.
const FIXTURES = resolve(process.cwd(), "../../e2e/fixtures/f14");
const fixture = (name: string, lastModified = Date.UTC(2026, 7, 18, 1, 0)) => new File([readFileSync(resolve(FIXTURES, name))], name, { type: name.endsWith(".md") ? "text/markdown" : "application/json", lastModified });

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  window.sessionStorage.clear();
});

function withoutRelations(capabilities: Capabilities): Capabilities {
  return { ...capabilities, features: capabilities.features.map((feature) => (feature.name === "relations" ? { name: feature.name, enabled: false } : feature)) };
}

function wrap({ relations = true, failTitle = "" } = {}) {
  const scenario = nasScenario();
  if (!relations) scenario.capabilities = withoutRelations(scenario.capabilities);
  const client = createMockTangentClient({ latencyMs: 0, scenario });
  mocks.push(client);
  if (failTitle) {
    const real = client.importConversation;
    vi.spyOn(client, "importConversation").mockImplementation((input, opts) => (input.title === failTitle ? Promise.reject(new TangentError(500, "connection lost", "internal")) : real(input, opts)));
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client as TangentClient} locale="zh-TW">
        <ShortcutsProvider>{children}</ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

/** Opens the dialog, loads the three files and checks the design's five (search "pg", all matches, minus two). */
async function pickFive(options: { relations?: boolean; failTitle?: string } = {}) {
  const { client, wrapper } = wrap(options);
  const onImported = vi.fn();
  render(<ImportDialog open onOpenChange={() => undefined} onImported={onImported} />, { wrapper });
  const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [fixture("chatgpt-pg.json"), fixture("claude-pg.json"), fixture("壓測筆記.md")] } });
  expect(await within(dialog).findByText("Markdown・1 篇")).toBeInTheDocument();
  fireEvent.change(within(dialog).getByRole("searchbox", { name: "搜尋標題與首問" }), { target: { value: "pg" } });
  expect(within(dialog).getByText("符合 7 / 9 篇")).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole("button", { name: "全選符合的" }));
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "PG 備份與 PITR" }));
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "pgvector 要不要用" }));
  return { client, dialog, onImported };
}

describe("S1 several files, search and picks", () => {
  it("loads three files as capsules, finds first prompts too, and sums up the five picked", async () => {
    const { dialog } = await pickFive();
    expect(within(dialog).getByText("ChatGPT・6 篇")).toBeInTheDocument();
    expect(dialog.querySelector('[data-tg-session-row*="f14-load"]')).toHaveTextContent("首問符合：pgbench 200 連線時 p95 飆高，從哪裡開始看？");
    expect(within(dialog).getByRole("button", { name: /檔案時間 08\/18/ })).toBeInTheDocument();
    expect(within(dialog).getByText("已勾選 5 篇・共 54 則訊息・橫跨 2026/08/12～08/20")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "快速匯入單篇" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(within(dialog).getByRole("searchbox", { name: "搜尋標題與首問" }), { target: { value: "微分幾何" } });
    expect(within(dialog).getByText("3 個檔案裡沒有符合「微分幾何」的對話。也搜了首問的內容。")).toBeInTheDocument();
  });

  it("keeps the other files when one cannot be read, and removes a file's capsule", async () => {
    const { wrapper } = wrap();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [fixture("claude-pg.json"), new File(["{}"], "notes.json", { type: "application/json" })] } });
    expect(await within(dialog).findByText(/「notes\.json」讀不懂，其他 1 個檔案已載入/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "最終設定檔" })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "移除「notes.json」" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("flags a conversation imported before in this session and leaves it unchecked (decision #10)", async () => {
    window.sessionStorage.setItem("tangent.f14.imported", JSON.stringify(["claude:f14-final"]));
    const { wrapper } = wrap();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [fixture("claude-pg.json")] } });
    expect(await within(dialog).findByText(/「最終設定檔」2026\/08\/20 已經匯入過。再匯入會變成第二份。/)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "最終設定檔" })).not.toBeChecked();
  });
});

describe("S2 order and the peek", () => {
  it("orders oldest first (the file-dated one by its file time), opens the peek with its pause, and moves with Alt+arrows", async () => {
    const { dialog } = await pickFive();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    const order = () => [...dialog.querySelectorAll("[data-tg-session-node]")].map((node) => node.querySelector("h4")?.textContent);
    expect(order()).toEqual(["PG 連線池設定", "PgBouncer transaction mode 的限制", "高併發壓測與鎖等待", "壓測筆記", "最終設定檔"]);
    await userEvent.click(within(dialog).getByRole("button", { name: /小展開・12 則・1 個時間斷點・1 個重問/ }));
    expect(within(dialog).getByText("間隔 2 小時 37 分")).toBeInTheDocument();
    expect(within(dialog).getByText(/結尾：default_pool_size 20/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /#5–#12/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "移除 #12" }));
    expect(within(dialog).getByRole("button", { name: "恢復 #12" })).toBeInTheDocument();
    const handle = within(dialog).getByRole("button", { name: /調整「壓測筆記」的順序/ });
    handle.focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(order()[2]).toBe("壓測筆記");
    // Moving down moves the focused card itself: its handle keeps (or gets back) focus.
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(order()[3]).toBe("壓測筆記");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /調整「壓測筆記」的順序/ })).toHaveFocus());
  });
});

describe("S3 modes, roles and cards; S4 import", () => {
  it("warns about the overlap in the timeline and 改用樹狀圖 brings B back on §1 #4 with its card", async () => {
    const { client, dialog, onImported } = await pickFive();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    expect(within(dialog).getByText(/偵測到時間穿插：「PgBouncer transaction mode 的限制」/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ })).toHaveTextContent("建議");
    await userEvent.click(within(dialog).getByRole("button", { name: "改用樹狀圖" }));
    expect(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ })).toHaveAttribute("aria-checked", "true");
    const branch = dialog.querySelector<HTMLElement>('[data-tg-blueprint-node="0"]') ?? [...dialog.querySelectorAll<HTMLElement>("[data-tg-blueprint-node]")].find((node) => node.textContent?.includes("已帶回"))!;
    expect(branch).toHaveTextContent(/掛在 §1 #4（\d\d:\d\d） ?之後・時間穿插/);
    expect(within(dialog).getByText(/將建立 1 條主線（4 個章節、1 條支線與結論卡，共 54 則訊息/)).toBeInTheDocument();
    // An empty conclusion keeps both import buttons off.
    await userEvent.click(within(branch).getByRole("button", { name: "改結論" }));
    const field = within(branch).getByRole("textbox", { name: "「PgBouncer transaction mode 的限制」的結論" });
    await userEvent.clear(field);
    expect(within(branch).getByText("結論不能空白")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "確認並純匯入" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(field, "改在交易內用 SET LOCAL。");
    await userEvent.click(within(dialog).getByRole("button", { name: "確認結構並展開拆解建議" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    const [outcome] = onImported.mock.calls[0]!;
    expect(outcome).toMatchObject({ assembled: true, decompose: true, messageCount: 54, toast: "已匯入：1 條主線、4 個章節、1 條支線與結論卡" });
    const messages = (await client.listMessages(outcome.focusLineId, { limit: 200 })).messages;
    expect(messages.find((message) => message.kind === "branch_card")?.meta.card?.conclusion).toBe("改在交易內用 SET LOCAL。");
    expect(window.sessionStorage.getItem("tangent.f14.imported")).toContain("chatgpt:f14-pg-pool");
    expect(await outcome.undo.run()).toBe("已復原：這次匯入的 1 條主線已刪除");
  });

  it("changes a node's role and attach point from its menu", async () => {
    const { dialog } = await pickFive();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ }));
    const node = [...dialog.querySelectorAll<HTMLElement>("[data-tg-blueprint-node]")].find((item) => item.textContent?.includes("壓測筆記"))!;
    await userEvent.click(within(node).getByRole("button", { name: /「壓測筆記」的角色/ }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /掛為支線並留結論卡/ }));
    expect(within(dialog).getByText(/將建立 1 條主線（3 個章節、2 條支線與結論卡/)).toBeInTheDocument();
    const moved = [...dialog.querySelectorAll<HTMLElement>("[data-tg-blueprint-node]")].find((item) => item.textContent?.includes("壓測筆記"))!;
    expect(moved).toHaveTextContent(/掛在 §2 #18（\d\d:\d\d） ?之後・依檔案時間/);
    expect(within(moved).getByText("調整後 TPS 1,840、p95 210ms。")).toBeInTheDocument();
  });

  it("imports a batch in order, related to each other, and says so without relations", async () => {
    const { client, dialog, onImported } = await pickFive();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /批次獨立匯入/ }));
    expect(within(dialog).getByText("將建立 5 條主線（4 條相鄰關聯，共 54 則訊息）・不呼叫模型")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "確認並純匯入" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    const [outcome] = onImported.mock.calls[0]!;
    expect(outcome.lineIds).toHaveLength(5);
    expect(client.mock.snapshot().links.filter((link) => link.kind === "relation")).toHaveLength(4);
  });

  it("keeps batch without relations, linking nothing", async () => {
    const { dialog } = await pickFive({ relations: false });
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    expect(within(dialog).getByRole("radio", { name: /批次獨立匯入/ })).toHaveTextContent("同資料夾・不建立關聯");
    await userEvent.click(within(dialog).getByRole("radio", { name: /批次獨立匯入/ }));
    expect(within(dialog).getByText("將建立 5 條主線（共 54 則訊息）・不呼叫模型")).toBeInTheDocument();
    expect(within(dialog).getByText("不建立關聯（關聯功能已關閉）")).toBeInTheDocument();
  });
});

describe("review fixes", () => {
  it("keeps step 2's mode and roles when going back to step 1 and on again", async () => {
    const { dialog } = await pickFive();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "上一步" }));
    expect(within(dialog).getByRole("heading", { name: "第 1 步，共 2 步：選擇對話" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    expect(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ })).toHaveAttribute("aria-checked", "true");
  });

  it("reports a batch that was partly made, retries just the failed one, and hands over every line", async () => {
    const { dialog, onImported } = await pickFive({ failTitle: "壓測筆記" });
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /批次獨立匯入/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "確認並純匯入" }));
    expect(await within(dialog).findByText(/5 條主線建好 4 條；「壓測筆記」沒有建立/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "上一步" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "完成" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(onImported.mock.calls[0]![0].lineIds).toHaveLength(4);
  });
});

describe("B21 a combined export", () => {
  const TITLES = ["如果電腦平常都不關, CPU散熱多久換一次比較好?", "firebase是什麼?", "PRD一般是對內還對外的?"];

  /** Loads the user's Gemini-Combined file, checks its three topics and goes on to step 2. */
  async function pickCombined() {
    const { wrapper } = wrap();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    const file = new File([JSON.stringify(geminiCombinedSample())], "Gemini-Combined_雜談-2026-11-03.json", { type: "application/json", lastModified: Date.UTC(2026, 10, 3, 12, 0) });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    expect(await within(dialog).findByText("Gemini・3 篇")).toBeInTheDocument();
    for (const title of TITLES) await userEvent.click(within(dialog).getByRole("checkbox", { name: title }));
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "改資料夾與標籤" }));
    return dialog;
  }

  it("cuts the file by topic and prefills the folder it came with", async () => {
    const dialog = await pickCombined();
    expect(within(dialog).getByRole("textbox", { name: "新資料夾名稱" })).toHaveValue("雜談");
  });

  it("keeps the folder the user changed, even to none", async () => {
    const dialog = await pickCombined();
    const field = within(dialog).getByRole("textbox", { name: "新資料夾名稱" });
    await userEvent.clear(field);
    await userEvent.type(field, "閒聊");
    expect(field).toHaveValue("閒聊");
    await userEvent.clear(field);
    expect(within(dialog).getByRole("textbox", { name: "新資料夾名稱" })).toHaveValue("");
  });

  it("prefills nothing for conversations without a folder", async () => {
    const { dialog } = await pickFive();
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "改資料夾與標籤" }));
    expect(within(dialog).queryByRole("textbox", { name: "新資料夾名稱" })).toBeNull();
  });
});

describe("F16.1 compact view, batch actions, merging and drop zones", () => {
  const TOPICS = ["Docker 容器是什麼?", "Kubernetes 叢集是什麼?", "PostgreSQL 索引是什麼?", "Redis 快取是什麼?", "Nginx 反向代理是什麼?"];
  /** A drag the way a browser starts one (jsdom has no DataTransfer). */
  const transfer = () => ({ dataTransfer: { setData: () => undefined, effectAllowed: "", dropEffect: "" } });
  const cards = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>("[data-tg-session-node]")];
  const titles = (dialog: HTMLElement) => cards(dialog).map((card) => card.querySelector("h4")?.textContent);
  const cardOf = (dialog: HTMLElement, title: string) => cards(dialog).find((card) => card.querySelector("h4")?.textContent === title)!;
  const pillOf = (card: HTMLElement) => card.querySelector("[data-tg-role-trigger]")!.textContent;
  const box = (dialog: HTMLElement, title: string) => within(dialog).getByRole("checkbox", { name: `選取「${title}」（Shift 可連選）` });

  /** Ten topics cut from one combined export, all picked, on step 2. */
  async function pickTopics() {
    const { client, wrapper } = wrap();
    const onImported = vi.fn();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={onImported} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    const file = new File([JSON.stringify(longCombinedExport(10, 3))], "Gemini-Combined_雜談-2026-11-03.json", { type: "application/json", lastModified: Date.UTC(2026, 10, 3, 12, 0) });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    expect(await within(dialog).findByText("Gemini・10 篇")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "全選符合的" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    return { client, dialog, onImported };
  }

  it("starts compact from 8 sessions, filters, selects a Shift range and sets roles for all of them", async () => {
    const { dialog } = await pickTopics();
    expect(cards(dialog)).toHaveLength(10);
    expect(titles(dialog).slice(0, 5)).toEqual(TOPICS);
    expect(within(dialog).getByRole("button", { name: "詳細卡片" })).toHaveAttribute("data-tg-compact-toggle");
    expect(within(dialog).queryByText(/^問：/)).toBeNull();
    // The filter row: a search over titles and first prompts.
    const search = within(dialog).getByRole("searchbox", { name: "篩選對話（標題與首問）" });
    fireEvent.change(search, { target: { value: "Redis" } });
    expect(titles(dialog)).toEqual(["Redis 快取是什麼?"]);
    fireEvent.change(search, { target: { value: "" } });
    // A click, then Shift+click three down: the four from the first to it are checked.
    const user = userEvent.setup();
    await user.click(box(dialog, TOPICS[0]!));
    await user.keyboard("{Shift>}");
    await user.click(box(dialog, TOPICS[3]!));
    await user.keyboard("{/Shift}");
    const bar = dialog.querySelector<HTMLElement>("[data-tg-batch-bar]")!;
    expect(bar).toHaveTextContent("已選 4 篇");
    await user.click(within(bar).getByRole("button", { name: "另存成獨立對話" }));
    for (const title of TOPICS.slice(0, 4)) expect(pillOf(cardOf(dialog, title))).toBe("獨立對話");
    expect(pillOf(cardOf(dialog, TOPICS[4]!))).toBe("§1");
    expect(within(dialog).getByText("已把 4 篇設為獨立對話。")).toBeInTheDocument();
    // A branch role in the timeline switches to the tree, says so, and keeps the rest.
    await user.click(within(bar).getByRole("button", { name: "掛為支線 ↳" }));
    expect(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText(/已改用「主幹＋支線樹」/)).toBeInTheDocument();
    for (const title of TOPICS.slice(0, 4)) expect(pillOf(cardOf(dialog, title))).toBe("↳ 支線");
    // Select all shown, then clear.
    await user.click(within(dialog).getByRole("checkbox", { name: "全選目前顯示（10）" }));
    expect(bar).toHaveTextContent("已選 10 篇");
    await user.click(within(bar).getByRole("button", { name: "取消選取" }));
    expect(dialog.querySelector("[data-tg-batch-bar]")).toBeNull();
  });

  it("merges two into one and splits them back, also from the menu, and imports a merged one as one conversation", async () => {
    const { dialog, onImported } = await pickTopics();
    await userEvent.click(box(dialog, TOPICS[0]!));
    await userEvent.click(box(dialog, TOPICS[1]!));
    await userEvent.click(within(dialog).getByRole("button", { name: "合併成 1 篇" }));
    expect(cards(dialog)).toHaveLength(9);
    const merged = cardOf(dialog, TOPICS[0]!);
    expect(merged).toHaveTextContent("已合併 2 篇");
    expect(merged).toHaveTextContent("12 則");
    expect(dialog.querySelector("[data-tg-batch-bar]")).toBeNull();
    await userEvent.click(within(merged).getByRole("button", { name: /「Docker 容器是什麼\?」的角色/ }));
    await userEvent.click(await screen.findByRole("button", { name: "拆回原本的 2 篇" }));
    expect(titles(dialog).slice(0, 5)).toEqual(TOPICS);
    expect(within(dialog).getByText("已把「Docker 容器是什麼?」拆回 2 篇。")).toBeInTheDocument();
    // 與上一篇合併 from the third one's menu, then import in batch: one conversation fewer, every message.
    await userEvent.click(within(cardOf(dialog, TOPICS[2]!)).getByRole("button", { name: /「PostgreSQL 索引是什麼\?」的角色/ }));
    await userEvent.click(await screen.findByRole("button", { name: "與上一篇合併" }));
    expect(cards(dialog)).toHaveLength(9);
    expect(cardOf(dialog, TOPICS[1]!)).toHaveTextContent("已合併 2 篇");
    await userEvent.click(within(dialog).getByRole("radio", { name: /批次獨立匯入/ }));
    expect(within(dialog).getByText(/將建立 9 條主線/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "確認並純匯入" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(onImported.mock.calls[0]![0]).toMatchObject({ messageCount: 60 });
    expect(onImported.mock.calls[0]![0].lineIds).toHaveLength(9);
  });

  it("keeps a message removed in a merged session with the session it came from when split back", async () => {
    const { dialog } = await pickTopics();
    await userEvent.click(box(dialog, TOPICS[0]!));
    await userEvent.click(box(dialog, TOPICS[1]!));
    await userEvent.click(within(dialog).getByRole("button", { name: "合併成 1 篇" }));
    const merged = cardOf(dialog, TOPICS[0]!);
    await userEvent.click(within(merged).getByRole("button", { name: "「Docker 容器是什麼?」的詳細資訊" }));
    await userEvent.click(within(merged).getByRole("button", { name: /#1–#12/ }));
    await userEvent.click(within(merged).getByRole("button", { name: "移除 #8" }));
    expect(merged).toHaveTextContent("11 則");
    await userEvent.click(within(merged).getByRole("button", { name: "拆回原本的 2 篇" }));
    const second = cardOf(dialog, TOPICS[1]!);
    expect(second).toHaveTextContent("5 則");
    await userEvent.click(within(second).getByRole("button", { name: "「Kubernetes 叢集是什麼?」的詳細資訊" }));
    await userEvent.click(within(second).getByRole("button", { name: /#1–#6/ }));
    expect(within(second).getByRole("button", { name: "恢復 #2" })).toBeInTheDocument();
  });

  it("drops on the role zones and on a chapter to hang under it or merge into it", async () => {
    const { dialog } = await pickTopics();
    const handleOf = (title: string) => within(cardOf(dialog, title)).getByRole("button", { name: `調整「${title}」的順序（拖拉，或 Alt＋上下鍵）` });
    const zone = dialog.querySelector<HTMLElement>('[data-tg-drop-role="standalone"]')!;
    expect(zone).toHaveAccessibleName("另存成獨立對話：把對話拖到這裡，或先勾選對話");
    fireEvent.dragStart(handleOf(TOPICS[3]!), transfer());
    fireEvent.dragOver(zone, transfer());
    fireEvent.drop(zone, transfer());
    expect(pillOf(cardOf(dialog, TOPICS[3]!))).toBe("獨立對話");
    // In the tree only the first is a chapter: drag onto §1's two targets.
    await userEvent.click(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ }));
    fireEvent.dragStart(handleOf(TOPICS[3]!), transfer());
    fireEvent.drop(await within(dialog).findByRole("button", { name: /掛在 §1「Docker 容器是什麼\?」下當支線/ }), transfer());
    expect(pillOf(cardOf(dialog, TOPICS[3]!))).toBe("↳ 支線");
    expect(within(dialog).getByText("已把 1 篇掛在 §1 下。")).toBeInTheDocument();
    expect(titles(dialog)[1]).toBe(TOPICS[3]);
    fireEvent.dragStart(handleOf(TOPICS[4]!), transfer());
    fireEvent.drop(await within(dialog).findByRole("button", { name: /合併進 §1「Docker 容器是什麼\?」/ }), transfer());
    expect(cardOf(dialog, TOPICS[0]!)).toHaveTextContent("已合併 2 篇");
    expect(cards(dialog)).toHaveLength(9);
  });

  it("allows multi-selecting nodes and performing batch actions targeting a specific node in the timeline list", async () => {
    const { dialog } = await pickTopics();
    // Select TOPICS[1] and TOPICS[2]
    await userEvent.click(box(dialog, TOPICS[1]!));
    await userEvent.click(box(dialog, TOPICS[2]!));

    // Target node TOPICS[0] in the timeline list displays target actions
    const targetCard = cardOf(dialog, TOPICS[0]!);
    const mergeBtn = targetCard.querySelector<HTMLButtonElement>("[data-tg-target-merge]")!;
    expect(mergeBtn).toBeInTheDocument();
    await userEvent.click(mergeBtn);

    // Verify merged into TOPICS[0]
    expect(cardOf(dialog, TOPICS[0]!)).toHaveTextContent("已合併 3 篇");
    expect(dialog.querySelector("[data-tg-batch-bar]")).toBeNull();

    // Split back
    await userEvent.click(within(cardOf(dialog, TOPICS[0]!)).getByRole("button", { name: "「Docker 容器是什麼?」的詳細資訊" }));
    await userEvent.click(within(cardOf(dialog, TOPICS[0]!)).getByRole("button", { name: "拆回原本的 3 篇" }));
    expect(cardOf(dialog, TOPICS[0]!)).not.toHaveTextContent("已合併");

    // Test BatchActionBar target selector
    await userEvent.click(box(dialog, TOPICS[3]!));
    await userEvent.click(box(dialog, TOPICS[4]!));
    const targetSelect = dialog.querySelector<HTMLSelectElement>("[data-tg-batch-target]")!;
    expect(targetSelect).toBeInTheDocument();
    // Select TOPICS[0] in the target select
    const topic0Option = [...targetSelect.options].find((opt) => opt.text.includes(TOPICS[0]!))!;
    await userEvent.selectOptions(targetSelect, topic0Option.value);

    // Click "合併進目標"
    const batchMergeBtn = dialog.querySelector<HTMLButtonElement>("[data-tg-batch-merge]")!;
    expect(batchMergeBtn).toHaveTextContent("合併進目標");
    await userEvent.click(batchMergeBtn);

    expect(cardOf(dialog, TOPICS[0]!)).toHaveTextContent("已合併 3 篇");
  });
});
