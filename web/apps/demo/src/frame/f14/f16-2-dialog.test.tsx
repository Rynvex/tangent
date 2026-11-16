// @vitest-environment jsdom
/** F16.2 in the import dialog: 「✨ AI 智慧分析支線樹」 on one mixed conversation, fine-tuning one round, undoing it, and a failure. */
import { TangentError, type TangentClient } from "@tangent/client";
import { createMockTangentClient, INTERLEAVED_ROUNDS, interleavedConversation, longCombinedExport, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImportDialog from "../import-dialog";

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  window.sessionStorage.clear();
});

function wrap() {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  mocks.push(client);
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

const nodes = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>("[data-tg-blueprint-node]")];
const nodeOf = (dialog: HTMLElement, title: string) => nodes(dialog).find((node) => node.textContent?.includes(title))!;
const summaryOf = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>("[data-tg-ai-summary]");
const [A, B, , C] = INTERLEAVED_ROUNDS.map(([question]) => question);

/** The A → B → A → C → A → B conversation uploaded, picked and on step 2. */
async function stepTwo() {
  const { client, wrapper } = wrap();
  const onImported = vi.fn();
  render(<ImportDialog open onOpenChange={() => undefined} onImported={onImported} />, { wrapper });
  const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
  const file = new File([JSON.stringify(interleavedConversation())], "電腦雜談.json", { type: "application/json", lastModified: Date.UTC(2026, 10, 3, 12, 0) });
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
  // The only conversation of the only file starts checked.
  await waitFor(() => expect(within(dialog).getByRole("checkbox", { name: "電腦雜談" })).toHaveAttribute("aria-checked", "true"));
  await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
  return { client, dialog, onImported };
}

describe("F16.2 the AI topic tree", () => {
  it("splits the rounds, threads A into §1 and hangs B and C on it with their cards", async () => {
    // Arrange
    const { client, dialog } = await stepTwo();
    const analyze = vi.spyOn(client, "analyzeImport");
    expect(within(dialog).getByRole("checkbox", { name: /拆解對話內部的穿插問答輪次/ })).toBeChecked();
    expect(nodes(dialog)).toHaveLength(1);
    // Act
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
    // Assert
    await waitFor(() => expect(summaryOf(dialog)).not.toBeNull());
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0]![0].units).toHaveLength(6);
    expect(summaryOf(dialog)).toHaveTextContent("1 個主幹章節、2 條支線、0 篇獨立對話（2 個主題跨段整合）");
    expect(summaryOf(dialog)).toHaveTextContent("由內建規則分析");
    expect(within(dialog).getByRole("radio", { name: /主幹＋支線樹/ })).toHaveAttribute("aria-checked", "true");
    expect(nodes(dialog)).toHaveLength(3);
    const a = nodeOf(dialog, A!);
    expect(a).toHaveTextContent("§1");
    expect(a.querySelector("[data-tg-ai-units-badge]")).toHaveTextContent("跨段整合 3 輪（#1, #3, #5）");
    expect(a.querySelector("[data-tg-ai-reason]")).toHaveTextContent("貫穿對話的主題");
    const b = nodeOf(dialog, B!);
    expect(b).toHaveTextContent("跨段整合 2 輪（#2, #6）");
    expect(b).toHaveTextContent(/掛在 §1 #2（.+） 之後/);
    expect(b).toHaveTextContent(`主線留下的結論卡改結論${INTERLEAVED_ROUNDS[5]![1]}`);
    const c = nodeOf(dialog, C!);
    expect(c).toHaveTextContent(/掛在 §1 #4（.+） 之後/);
    expect(within(dialog).getByText(/將建立 1 條主線/)).toBeInTheDocument();
  });

  it("moves one round out as a separate conversation from the node's rounds, and undoes the analysis exactly", async () => {
    const { dialog } = await stepTwo();
    const before = dialog.querySelector("[data-tg-blueprint-node]")!.getAttribute("data-tg-blueprint-node");
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
    await waitFor(() => expect(summaryOf(dialog)).not.toBeNull());
    const a = nodeOf(dialog, A!);
    const toggle = a.querySelector<HTMLButtonElement>("[data-tg-node-units-toggle]")!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(a).getAllByRole("listitem").map((item) => item.querySelector("span")?.textContent)).toEqual(["#1", "#3", "#5"]);
    const round5 = within(a).getByRole("combobox", { name: "移動第 #5 輪" });
    await userEvent.selectOptions(round5, "拆出成為獨立對話");
    expect(nodeOf(dialog, A!).querySelector("[data-tg-ai-units-badge]")).toHaveTextContent("跨段整合 2 輪（#1, #3）");
    expect(summaryOf(dialog)).toHaveTextContent("1 個主幹章節、2 條支線、1 篇獨立對話");
    expect(within(dialog).getByText(/將建立 2 條主線/)).toBeInTheDocument();
    expect(within(dialog).getByText("已把 #5 拆出成新的節點。")).toBeInTheDocument();
    // Moving it back into A from the separate node's own rounds.
    // The new node opens on its round (the move's destination is shown open).
    const separate = nodes(dialog).find((node) => node.getAttribute("data-tg-blueprint-node")!.endsWith("#turn-5"))!;
    expect(separate).toHaveTextContent("獨立對話");
    expect(separate.querySelector("[data-tg-node-units-toggle]")).toHaveAttribute("aria-expanded", "true");
    await userEvent.selectOptions(within(separate).getByRole("combobox", { name: "移動第 #5 輪" }), within(separate).getByRole("option", { name: /^§1 / }));
    expect(nodeOf(dialog, A!).querySelector("[data-tg-ai-units-badge]")).toHaveTextContent("跨段整合 3 輪（#1, #3, #5）");
    // Undo: the one conversation in the timeline again.
    await userEvent.click(within(dialog).getByRole("button", { name: "還原分析前狀態" }));
    expect(summaryOf(dialog)).toBeNull();
    expect(nodes(dialog).map((node) => node.getAttribute("data-tg-blueprint-node"))).toEqual([before]);
    expect(within(dialog).getByRole("radio", { name: /時間軸章節圖/ })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText("已還原分析前的排列。")).toBeInTheDocument();
  });

  it("hangs a branch on another chapter and changes roles in one click", async () => {
    const { dialog } = await stepTwo();
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
    await waitFor(() => expect(summaryOf(dialog)).not.toBeNull());
    await userEvent.click(within(nodeOf(dialog, C!)).getByRole("button", { name: "升為主幹章節 §" }));
    expect(nodeOf(dialog, C!)).toHaveTextContent("§2");
    await userEvent.selectOptions(within(nodeOf(dialog, B!)).getByRole("combobox", { name: /掛在哪個章節/ }), within(nodeOf(dialog, B!)).getByRole("option", { name: /^§2 / }));
    expect(nodeOf(dialog, B!)).toHaveTextContent("掛在 §2");
    await userEvent.click(within(nodeOf(dialog, B!)).getByRole("button", { name: "改為獨立對話" }));
    expect(summaryOf(dialog)).toHaveTextContent("2 個主幹章節、0 條支線、1 篇獨立對話");
  });

  it("analyzes many conversations whole, keeping a merge made before, and gives that merge back on undo", async () => {
    const { client, wrapper } = wrap();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    const file = new File([JSON.stringify(longCombinedExport(10, 3))], "Gemini-Combined_雜談-2026-11-03.json", { type: "application/json", lastModified: Date.UTC(2026, 10, 3, 12, 0) });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    expect(await within(dialog).findByText("Gemini・10 篇")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "全選符合的" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    // Ten conversations: no rounds option; two merged first.
    expect(within(dialog).queryByRole("checkbox", { name: /拆解對話內部的穿插問答輪次/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "選取「Docker 容器是什麼?」（Shift 可連選）" }));
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "選取「Kubernetes 叢集是什麼?」（Shift 可連選）" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "合併成 1 篇" }));
    const analyze = vi.spyOn(client, "analyzeImport");
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
    await waitFor(() => expect(summaryOf(dialog)).not.toBeNull());
    expect(analyze.mock.calls[0]![0].units).toHaveLength(9);
    expect(summaryOf(dialog)).toHaveTextContent("9 個主幹章節、0 條支線、0 篇獨立對話");
    await userEvent.click(within(dialog).getByRole("button", { name: "還原分析前狀態" }));
    expect(within(dialog).getByRole("radio", { name: /時間軸章節圖/ })).toHaveAttribute("aria-checked", "true");
    expect(nodeOf(dialog, "Docker 容器是什麼?")).toHaveTextContent("已合併 2 篇");
    expect(nodes(dialog)).toHaveLength(9);
  });

  it("does not apply an answer when the arrangement changed while it was asked", async () => {
    const { client, dialog } = await stepTwo();
    const real = client.analyzeImport;
    let answer: () => void = () => undefined;
    vi.spyOn(client, "analyzeImport").mockImplementationOnce((input, opts) => new Promise((resolve, reject) => (answer = () => real(input, opts).then(resolve, reject))));
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
    expect(dialog.querySelector("[data-tg-ai-busy]")).toHaveTextContent("AI 正在分析跨段話題並建構支線樹…");
    await userEvent.click(within(dialog).getByRole("radio", { name: /批次獨立匯入/ }));
    answer();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("分析期間排列有了變動");
    expect(summaryOf(dialog)).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /批次獨立匯入/ })).toHaveAttribute("aria-checked", "true");
  });

  it("says a failed request in words, keeps everything, and tries again", async () => {
    const { client, dialog } = await stepTwo();
    const real = client.analyzeImport;
    const analyze = vi.spyOn(client, "analyzeImport").mockRejectedValueOnce(new TangentError(0, "Failed to fetch", "network"));
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/分析失敗：.*目前的排列沒有變動/);
    expect(nodes(dialog)).toHaveLength(1);
    analyze.mockImplementation(real);
    await userEvent.click(within(alert).getByRole("button", { name: "再試一次" }));
    await waitFor(() => expect(summaryOf(dialog)).not.toBeNull());
    expect(nodes(dialog)).toHaveLength(3);
  });
});
