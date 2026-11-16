// @vitest-environment jsdom
/**
 * F17 in the import dialog: step 2's mind map workspace on the design's nine
 * rounds (S1 the view switch and full width, S2 the tree, S3 the turn order,
 * S4 the inspector, S5 moving rounds and nodes; decisions #6 and #8), before
 * an analysis, in batch, and on a phone.
 */
import type { TangentClient } from "@tangent/client";
import { createMockTangentClient, longCombinedExport, MINDMAP_ROUNDS, mindmapConversation, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ImportDialog from "../import-dialog";

const mocks: Array<{ mock: { dispose(): void } }> = [];
const desktopWidth = window.innerWidth;
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  window.sessionStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: desktopWidth });
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

const [Q1, Q2, , Q4, , , Q7, Q8] = MINDMAP_ROUNDS.map(([question]) => question);
const TITLE = "電腦散熱與硬體維護雜談";

/** The nine rounds uploaded as one conversation, picked, on step 2 (the list, as before F17). */
async function stepTwo({ phone = false } = {}) {
  if (phone) Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  const { client, wrapper } = wrap();
  render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
  const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
  const file = new File([JSON.stringify(mindmapConversation())], "電腦散熱.json", { type: "application/json", lastModified: Date.UTC(2026, 10, 3, 12, 0) });
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
  await waitFor(() => expect(within(dialog).getByRole("checkbox", { name: TITLE })).toHaveAttribute("aria-checked", "true"));
  await userEvent.click(within(dialog).getByRole("button", { name: phone ? "下一步：排序與結構" : "下一步：時間序拼圖預覽" }));
  return { client, dialog };
}

async function analyze(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("button", { name: "✨ AI 智慧分析並畫出支線樹" }));
  await waitFor(() => expect(dialog.querySelector("[data-tg-ai-summary]")).not.toBeNull());
}

const tree = (dialog: HTMLElement) => within(dialog).getByRole("tree", { name: "結構心智圖" });
const nodes = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>("[data-tg-mindmap-node]")];
const nodeOf = (dialog: HTMLElement, title: string) => nodes(dialog).find((node) => node.textContent?.includes(title))!;
const chipsOf = (node: HTMLElement) => [...node.querySelectorAll("[data-tg-mindmap-chip]")].map((chip) => chip.textContent);
const inspector = (dialog: HTMLElement) => within(dialog).getByRole("complementary", { name: "節點問答明細" });
/** A drop target, once the drag state has been drawn (just after dragstart). */
async function appeared(dialog: HTMLElement, selector: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = dialog.querySelector<HTMLElement>(selector);
    expect(found).not.toBeNull();
    return found!;
  });
}
const pillFor = (dialog: HTMLElement, index: number) => dialog.querySelectorAll<HTMLElement>("[data-tg-mindmap-fork]")[index]!;

/** Analyzed, then on the mind map workspace. */
async function onMap(options: { phone?: boolean } = {}) {
  const step = await stepTwo(options);
  await analyze(step.dialog);
  await userEvent.click(within(step.dialog).getByRole("radio", { name: options.phone ? "心智圖" : "心智圖工作區" }));
  return step;
}

describe("S1–S2 the workspace and its tree", () => {
  it("opens on the list, switches to the mind map with the root, two chapters, two branches and the lane, and the 460 inspector", async () => {
    // Arrange
    const { dialog } = await stepTwo();
    expect(within(dialog).getByRole("radio", { name: "雙欄時間序清單" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByRole("button", { name: "全幅心智圖（收合明細欄）" })).toBeDisabled();
    await analyze(dialog);
    // Act
    await userEvent.click(within(dialog).getByRole("radio", { name: "心智圖工作區" }));
    // Assert
    expect(dialog.querySelectorAll("[data-tg-blueprint-node]")).toHaveLength(0);
    expect(within(tree(dialog)).getAllByRole("treeitem")).toHaveLength(6);
    expect(dialog.querySelector("[data-tg-mindmap-root]")).toHaveTextContent("2 章節・2 支線・1 獨立・18 則");
    const s1 = nodeOf(dialog, Q1!);
    expect(s1).toHaveTextContent("§1");
    expect(s1).toHaveTextContent("跨段整合 3 輪");
    expect(chipsOf(s1)).toEqual(["#1", "#3", "#5"]);
    const s2 = nodeOf(dialog, Q8!);
    expect(s2).toHaveTextContent("§2");
    expect(s2).not.toHaveTextContent("跨段整合");
    expect(chipsOf(nodeOf(dialog, Q2!))).toEqual(["#2", "#6"]);
    expect(nodeOf(dialog, Q2!)).toHaveTextContent("支線・附結論卡");
    expect([pillFor(dialog, 0).textContent, pillFor(dialog, 1).textContent]).toEqual(["自 §1 的 #1 後分岔", "自 §1 的 #3 後分岔"]);
    expect(chipsOf(nodeOf(dialog, Q7!))).toEqual(["#7"]);
    expect(dialog.querySelector("[data-tg-mindmap-lane]")).not.toBeNull();
    expect(within(dialog).getByText("另存為獨立對話（不併入上方主線樹）")).toBeInTheDocument();
    // §1 is shown first; the inspector is the 460 column on the right.
    expect(s1).toHaveAttribute("aria-selected", "true");
    expect(inspector(dialog)).toHaveClass("w-[460px]");
    expect(inspector(dialog)).toHaveAttribute("data-tg-mindmap-inspector", s1.getAttribute("data-tg-mindmap-node"));
    expect(within(dialog).getByText(/將建立 2 條主線/)).toBeInTheDocument();
  });

  it("folds the inspector away at full width, and a chosen node brings it back", async () => {
    const { dialog } = await onMap();
    await userEvent.click(within(dialog).getByRole("button", { name: "全幅心智圖（收合明細欄）" }));
    expect(within(dialog).queryByRole("complementary", { name: "節點問答明細" })).toBeNull();
    expect(within(dialog).getByText("點一個節點，在右側看問答明細")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "回到心智圖工作區（顯示明細欄）" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(nodeOf(dialog, Q2!));
    expect(inspector(dialog)).toHaveAttribute("data-tg-mindmap-inspector", nodeOf(dialog, Q2!).getAttribute("data-tg-mindmap-node"));
    expect(within(dialog).queryByText("點一個節點，在右側看問答明細")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "全幅心智圖（收合明細欄）" })).toHaveAttribute("aria-pressed", "false");
    // Back to the list: the F16.2 preview as before, full width off.
    await userEvent.click(within(dialog).getByRole("radio", { name: "雙欄時間序清單" }));
    expect(dialog.querySelectorAll("[data-tg-blueprint-node]")).toHaveLength(5);
    expect(within(dialog).getByRole("button", { name: "全幅心智圖（收合明細欄）" })).toBeDisabled();
  });

  it("opens from the list's entry and the result line too", async () => {
    const { dialog } = await stepTwo();
    await userEvent.click(within(dialog).getByRole("button", { name: "切換至心智圖工作區（檢視分岔位置與穿插順序）" }));
    expect(tree(dialog)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("radio", { name: "雙欄時間序清單" }));
    await analyze(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "在心智圖工作區檢視這棵樹" }));
    expect(within(tree(dialog)).getAllByRole("treeitem")).toHaveLength(6);
  });

  it("moves with the arrow keys, selecting as it goes, and Enter takes focus to the details", async () => {
    const { dialog } = await onMap();
    const s1 = nodeOf(dialog, Q1!);
    s1.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(nodeOf(dialog, Q2!)).toHaveFocus());
    expect(nodeOf(dialog, Q2!)).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(nodeOf(dialog, Q4!)).toHaveFocus());
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(nodeOf(dialog, Q1!)).toHaveFocus());
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(dialog.querySelector("[data-tg-mindmap-root]")).toHaveFocus());
    // The root's details are the main line's settings: the mode, title, folder and tags (the list's, on the map).
    const root = inspector(dialog);
    expect(within(root).getByRole("radiogroup", { name: "組裝方式" })).toBeInTheDocument();
    await userEvent.type(within(root).getByRole("textbox", { name: "主線標題" }), "散熱筆記");
    expect(dialog.querySelector("[data-tg-mindmap-root]")).toHaveTextContent("散熱筆記");
    dialog.querySelector<HTMLElement>("[data-tg-mindmap-root]")!.focus();
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(nodeOf(dialog, Q7!)).toHaveFocus());
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(within(inspector(dialog)).getByRole("heading", { level: 3, name: Q7 })).toHaveFocus());
    // Only one card is in the tab order.
    expect(within(tree(dialog)).getAllByRole("treeitem").filter((item) => item.tabIndex === 0)).toHaveLength(1);
  });
});

describe("S3 the turn order", () => {
  it("draws #1→#6 with labelled curves and marks the chips that take part", async () => {
    const { dialog } = await onMap();
    const toggle = dialog.querySelector<HTMLElement>("[data-tg-mindmap-trace-toggle]")!;
    expect(toggle).toHaveTextContent("顯示穿插順序#1→#6");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect([...dialog.querySelectorAll("[data-tg-mindmap-trace-label]")].map((label) => label.textContent)).toEqual(["1→2", "2→3", "3→4", "4→5", "5→6"]);
    expect(dialog.querySelectorAll("[data-tg-mindmap-trace-path]")).toHaveLength(5);
    expect(within(dialog).getByRole("group", { name: "圖例" })).toHaveTextContent("穿插順序");
    expect(nodeOf(dialog, Q1!).querySelector('[data-tg-mindmap-chip="1"]')).toHaveClass("border-tg-warning");
    expect(nodeOf(dialog, Q8!).querySelector('[data-tg-mindmap-chip="8"]')).not.toHaveClass("border-tg-warning");
  });

  it("is off before an analysis, and says why", async () => {
    const { dialog } = await stepTwo();
    await userEvent.click(within(dialog).getByRole("radio", { name: "心智圖工作區" }));
    const toggle = dialog.querySelector<HTMLElement>("[data-tg-mindmap-trace-toggle]")!;
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle).toHaveAccessibleDescription("還沒有穿插的輪次：先用 AI 分析並拆解輪次。");
    await userEvent.click(toggle);
    expect(dialog.querySelectorAll("[data-tg-mindmap-trace-label]")).toHaveLength(0);
  });
});

describe("S4 the node inspector", () => {
  it("shows a branch's role, where it hangs, the reason, its card and every round", async () => {
    const { dialog } = await onMap();
    await userEvent.click(nodeOf(dialog, Q2!));
    const panel = inspector(dialog);
    expect(within(panel).getByRole("radio", { name: "掛為支線" })).toHaveAttribute("aria-checked", "true");
    const chapter = within(panel).getByRole("combobox", { name: /掛在哪個章節/ }) as HTMLSelectElement;
    expect(chapter.selectedOptions[0]).toHaveTextContent(`§1 ${Q1}`);
    const anchor = within(panel).getByRole("combobox", { name: /在哪一輪之後分岔/ }) as HTMLSelectElement;
    expect(anchor.selectedOptions[0]).toHaveTextContent("第 #1 輪之後");
    expect([...anchor.options].map((option) => option.textContent)).toEqual(["第 #1 輪之後", "第 #3 輪之後", "第 #5 輪之後"]);
    expect(panel.querySelector("[data-tg-inspector-reason]")).toHaveTextContent("AI 歸納理由：");
    expect(within(panel).getByRole("textbox", { name: `「${Q2}」的結論` })).toHaveValue(MINDMAP_ROUNDS[5]![1]);
    const rounds = [...panel.querySelectorAll("[data-tg-inspector-round]")];
    expect(rounds.map((round) => round.querySelector("span span:nth-child(2)")?.textContent)).toEqual(["#2", "#6"]);
    expect(rounds[0]).toHaveTextContent(`提問：${Q2}`);
    expect(rounds[0]).toHaveTextContent(`回覆：${MINDMAP_ROUNDS[1]![1]}`);
    const expand = within(rounds[0] as HTMLElement).getByRole("button", { name: "展開完整回覆" });
    await userEvent.click(expand);
    expect(within(rounds[0] as HTMLElement).getByRole("button", { name: "收合回覆" })).toHaveAttribute("aria-expanded", "true");
    // The card is the assembly's: editing it here changes the branch's line on the canvas.
    const card = within(panel).getByRole("textbox", { name: `「${Q2}」的結論` });
    await userEvent.clear(card);
    await userEvent.type(card, "選 Supabase");
    expect(nodeOf(dialog, Q2!)).toHaveTextContent("選 Supabase");
  });

  it("re-anchors a branch to another round of its chapter and changes roles in one click", async () => {
    const { dialog } = await onMap();
    await userEvent.click(nodeOf(dialog, Q2!));
    await userEvent.selectOptions(within(inspector(dialog)).getByRole("combobox", { name: /在哪一輪之後分岔/ }), "第 #5 輪之後");
    expect(pillFor(dialog, 0)).toHaveTextContent("自 §1 的 #5 後分岔");
    await userEvent.click(within(inspector(dialog)).getByRole("radio", { name: "獨立對話" }));
    expect(dialog.querySelector("[data-tg-mindmap-root]")).toHaveTextContent("2 章節・1 支線・2 獨立");
    await userEvent.click(within(inspector(dialog)).getByRole("radio", { name: "設為主幹 §" }));
    expect(dialog.querySelector("[data-tg-mindmap-root]")).toHaveTextContent("3 章節・1 支線・1 獨立");
  });
});

describe("S5 moving rounds and nodes", () => {
  it("moves a round from its menu, and a moved fork round re-anchors its branch with a warning until confirmed", async () => {
    const { dialog } = await onMap();
    // #5 to the Firebase branch from §1's details.
    await userEvent.click(within(inspector(dialog)).getByRole("button", { name: "把第 #5 輪移至其他節點" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^↳ ${Q2!.slice(0, 10)}`) }));
    expect(chipsOf(nodeOf(dialog, Q1!))).toEqual(["#1", "#3"]);
    expect(chipsOf(nodeOf(dialog, Q2!))).toEqual(["#2", "#5", "#6"]);
    expect(dialog.querySelector("[data-tg-step-status]")).toHaveTextContent("已把 #5 移到");
    // #3, the round the AIO branch forked after, leaves §1: it now forks after #1, flagged.
    await userEvent.click(nodeOf(dialog, Q1!));
    await userEvent.click(within(inspector(dialog)).getByRole("button", { name: "把第 #3 輪移至其他節點" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "拆成獨立對話" }));
    const moved = dialog.querySelector<HTMLElement>('[data-tg-mindmap-fork="moved"]')!;
    expect(moved).toHaveTextContent("分岔點已移動・自 §1 的 #1 後分岔");
    expect(moved).toHaveClass("border-tg-warning");
    expect(dialog.querySelector("[data-tg-step-status]")).toHaveTextContent("分岔點已移動");
    await userEvent.click(nodeOf(dialog, Q4!));
    expect(nodeOf(dialog, Q4!)).toHaveAccessibleName(/分岔點已移動/);
    expect(within(inspector(dialog)).getByText("原本的分岔輪次被移走了，已改掛在 #1 之後。")).toBeInTheDocument();
    await userEvent.click(within(inspector(dialog)).getByRole("button", { name: "確認分岔點" }));
    expect(dialog.querySelector('[data-tg-mindmap-fork="moved"]')).toBeNull();
    expect(pillFor(dialog, 1)).toHaveTextContent("自 §1 的 #1 後分岔");
  });

  it("drops the warning when the fork is chosen any other way (hung on another chapter)", async () => {
    const { dialog } = await onMap();
    await userEvent.click(within(inspector(dialog)).getByRole("button", { name: "把第 #3 輪移至其他節點" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "拆成獨立對話" }));
    expect(dialog.querySelector('[data-tg-mindmap-fork="moved"]')).not.toBeNull();
    await userEvent.click(nodeOf(dialog, Q4!));
    const hangs = within(inspector(dialog)).getByRole("combobox", { name: /掛在哪個章節/ });
    await userEvent.selectOptions(hangs, within(hangs).getByRole("option", { name: /^§2 / }));
    expect(dialog.querySelector('[data-tg-mindmap-fork="moved"]')).toBeNull();
    expect(within(inspector(dialog)).queryByRole("button", { name: "確認分岔點" })).toBeNull();
  });

  it("drops a round dragged from the details on a node, and a node on a chapter's zones and on the lane", async () => {
    const { dialog } = await onMap();
    // S5b: #5 from §1's details onto the AIO branch.
    fireEvent.dragStart(within(inspector(dialog)).getByRole("button", { name: "拖曳第 #5 輪" }));
    const aio = nodeOf(dialog, Q4!).getAttribute("data-tg-mindmap-node")!;
    const target = await appeared(dialog, `[data-tg-mindmap-drop-turn="${CSS.escape(aio)}"]`);
    expect(target).toHaveTextContent("將第 #5 輪併入此節點");
    expect(dialog.querySelector(`[data-tg-mindmap-drop-turn="${CSS.escape(nodeOf(dialog, Q1!).getAttribute("data-tg-mindmap-node")!)}"]`)).toBeNull();
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(chipsOf(nodeOf(dialog, Q4!))).toEqual(["#4", "#5"]);
    expect(dialog.querySelector("[data-tg-mindmap-drop-turn]")).toBeNull();
    // S5a: the AIO branch onto §2's 「合併進 §2」.
    fireEvent.dragStart(nodeOf(dialog, Q4!));
    const s2 = nodeOf(dialog, Q8!).getAttribute("data-tg-mindmap-node")!;
    const merge = await appeared(dialog, `[data-tg-mindmap-drop-merge="${CSS.escape(s2)}"]`);
    expect(merge).toHaveTextContent("合併進 §2");
    expect(dialog.querySelector(`[data-tg-mindmap-drop-branch="${CSS.escape(s2)}"]`)).toHaveTextContent("掛在 §2 下當支線");
    expect(within(dialog).getByText("放到這裡：另存為獨立對話")).toBeInTheDocument();
    fireEvent.dragOver(merge);
    fireEvent.drop(merge);
    // §2 now holds #4 #5 #8 #9: stitched, so its row shows two chips and 「+2」.
    expect(chipsOf(nodeOf(dialog, Q8!))).toEqual(["#4", "#5", "+2"]);
    // The Firebase branch onto the lane: a separate conversation.
    fireEvent.dragStart(nodeOf(dialog, Q2!));
    const lane = dialog.querySelector<HTMLElement>("[data-tg-mindmap-lane]")!;
    await waitFor(() => expect(within(dialog).getByText("放到這裡：另存為獨立對話")).toBeInTheDocument());
    fireEvent.dragOver(lane);
    fireEvent.drop(lane);
    expect(dialog.querySelector("[data-tg-mindmap-root]")).toHaveTextContent("2 章節・0 支線・2 獨立");
  });
});

describe("decision #8 analyzing again", () => {
  it("asks before replacing hand adjustments, and 還原分析前狀態 goes back to before the first analysis", async () => {
    const { client, dialog } = await onMap();
    const again = vi.spyOn(client, "analyzeImport");
    // Untouched: analyzing again just runs.
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ 重新分析" }));
    await waitFor(() => expect(again).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(nodes(dialog)).toHaveLength(5));
    await userEvent.click(within(inspector(dialog)).getByRole("button", { name: "把第 #5 輪移至其他節點" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "拆成獨立對話" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ 重新分析" }));
    const ask = within(dialog).getByRole("group", { name: "重新分析會取代目前的調整，確定重新分析？" });
    expect(within(ask).getByRole("button", { name: "確定重新分析" })).toHaveFocus();
    expect(again).toHaveBeenCalledTimes(1);
    await userEvent.click(within(ask).getByRole("button", { name: "取消" }));
    expect(within(dialog).queryByRole("group", { name: /重新分析會取代/ })).toBeNull();
    expect(nodes(dialog)).toHaveLength(6);
    await userEvent.click(within(dialog).getByRole("button", { name: "✨ 重新分析" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "確定重新分析" }));
    await waitFor(() => expect(nodes(dialog)).toHaveLength(5));
    expect(again).toHaveBeenCalledTimes(2);
    await userEvent.click(within(dialog).getByRole("button", { name: "還原分析前狀態" }));
    expect(nodes(dialog)).toHaveLength(1);
    expect(nodes(dialog)[0]).toHaveTextContent("9 輪・18 則");
  });
});

describe("before an analysis, in batch, and on a phone", () => {
  it("draws the whole conversation as one chapter with its nine rounds, the only chapter kept a chapter", async () => {
    const { dialog } = await stepTwo();
    await userEvent.click(within(dialog).getByRole("radio", { name: "心智圖工作區" }));
    expect(nodes(dialog)).toHaveLength(1);
    expect(nodes(dialog)[0]).toHaveTextContent("9 輪・18 則");
    const panel = inspector(dialog);
    expect(panel.querySelectorAll("[data-tg-inspector-round]")).toHaveLength(9);
    expect(panel).toHaveTextContent(`提問：${Q1}`);
    expect(within(panel).getByText("用 AI 分析並拆解輪次後，就能把單一輪移到其他節點。")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /移至其他節點/ })).toBeNull();
    expect(within(panel).getByRole("radio", { name: "獨立對話" })).toHaveAttribute("aria-disabled", "true");
    expect(within(panel).getByRole("radiogroup", { name: "角色" })).toHaveAccessibleDescription("主線至少要有 1 個章節。");
  });

  it("shows a batch as a lane of conversations of their own, without a main line", async () => {
    const { wrapper } = wrap();
    render(<ImportDialog open onOpenChange={() => undefined} onImported={() => undefined} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "匯入對話" });
    const file = new File([JSON.stringify(longCombinedExport(10, 3))], "Gemini-Combined_雜談-2026-11-03.json", { type: "application/json", lastModified: Date.UTC(2026, 10, 3, 12, 0) });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });
    expect(await within(dialog).findByText("Gemini・10 篇")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "全選符合的" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "下一步：時間序拼圖預覽" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: /批次獨立匯入/ }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "心智圖工作區" }));
    expect(dialog.querySelector("[data-tg-mindmap-root]")).toBeNull();
    const items = within(tree(dialog)).getAllByRole("treeitem");
    expect(items).toHaveLength(10);
    expect(items.every((item) => item.getAttribute("aria-level") === "1")).toBe(true);
    expect(within(dialog).getByText("批次匯入：每篇各自成為一條主線")).toBeInTheDocument();
  });

  it("on a phone: the canvas over its details, the original order as a list, and a bottom sheet to move a round", async () => {
    const { dialog } = await onMap({ phone: true });
    expect(within(dialog).getByRole("tab", { name: /結構圖/ })).toHaveAttribute("aria-selected", "true");
    expect(dialog.querySelectorAll("[data-tg-mindmap-node][draggable]")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "顯示穿插順序" }));
    const order = dialog.querySelector<HTMLElement>("[data-tg-mindmap-trace-list]")!;
    expect(order).toHaveTextContent("原對話的穿插順序");
    expect([...order.querySelectorAll("[data-tg-trace-row]")].map((row) => row.getAttribute("data-tg-trace-row"))).toEqual(["1", "2", "3", "4", "5", "6"]);
    await userEvent.click(order.querySelector<HTMLElement>('[data-tg-trace-row="4"]')!);
    expect(nodeOf(dialog, Q4!)).toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "顯示穿插順序" }));
    await userEvent.click(nodeOf(dialog, Q1!));
    expect(within(inspector(dialog)).queryByRole("button", { name: /^拖曳/ })).toBeNull();
    await userEvent.click(within(inspector(dialog)).getByRole("button", { name: "把第 #5 輪移至其他節點" }));
    const sheet = await screen.findByRole("dialog", { name: "把第 #5 輪移到…" });
    const choices = within(sheet).getAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toContain("拆成新支線");
    expect(choices.find((choice) => choice.getAttribute("aria-checked") === "true")).toHaveTextContent(`§1 ${Q1!.slice(0, 10)}`);
    await userEvent.click(within(sheet).getByRole("menuitemradio", { name: "拆成獨立對話" }));
    expect(chipsOf(nodeOf(dialog, Q1!))).toEqual(["#1", "#3"]);
    expect(nodes(dialog)).toHaveLength(6);
  });
});
