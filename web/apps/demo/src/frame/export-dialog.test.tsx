// @vitest-environment jsdom
import { normalizeTreeExport, type TangentClient, type TreeExport } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExportDialog } from "./export-dialog";

/** F8 S9: the export dialog over a client whose `exportTree` answers with a fixed tree (or fails). */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

const msg = (id: string, lineId: string, seq: number, role: string, content: string) => ({ id, lineId, seq, role, kind: "chat", status: "done", content, meta: {} });

function exportOf(overrides: Record<string, unknown> = {}): TreeExport {
  return normalizeTreeExport({
    rootLineId: NAS_ROOT_ID,
    exportedAt: "2026-10-25T08:00:00Z",
    truncated: false,
    rootLine: { id: NAS_ROOT_ID, title: "家用 NAS 與備份策略" },
    branches: [
      { lineId: "b-aside", parentLineId: NAS_ROOT_ID, rootLineId: NAS_ROOT_ID, anchorMessageId: "m2", kind: "aside", status: "merged", purpose: "scrub 多久跑一次？" },
      { lineId: "b-dead", parentLineId: NAS_ROOT_ID, rootLineId: NAS_ROOT_ID, anchorMessageId: "m2", kind: "investigate", status: "discarded", purpose: "二手企業碟", leaf: { kind: "dead_end", line: "保固太短", status: "confirmed" } },
    ],
    messagesByLine: {
      [NAS_ROOT_ID]: [msg("m1", NAS_ROOT_ID, 1, "user", "要不要買 NAS？"), msg("m2", NAS_ROOT_ID, 2, "assistant", "看你的資料量。")],
      "b-aside": [msg("a1", "b-aside", 3, "user", "scrub 多久跑一次？"), msg("a2", "b-aside", 4, "assistant", "每月一次。")],
    },
    notes: [{ id: "n1", section: "fact", text: "ZFS 會自動檢查", status: "active", sourceLineId: NAS_ROOT_ID }],
    ...overrides,
  });
}

async function setup(answer: () => Promise<TreeExport>) {
  const mock = createMockTangentClient({ latencyMs: 0, chunkMs: 5, scenario: nasScenario() });
  mocks.push(mock);
  const exportTree = vi.fn(answer);
  const client = { ...mock, exportTree } as unknown as TangentClient;
  const download = vi.fn();
  const outline = (await mock.listBranches(NAS_ROOT_ID, { includeAside: true })).branches;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="zh-TW">
        <ExportDialog open onOpenChange={() => undefined} rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} title="家用 NAS 與備份策略" outline={outline} download={download} />
      </TangentProvider>
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole("dialog", { name: "匯出「家用 NAS 與備份策略」" });
  return { dialog, exportTree, download, outline };
}

const formats = (dialog: HTMLElement) => within(within(dialog).getByRole("radiogroup", { name: "格式" }));

describe("ExportDialog (F8 S9)", () => {
  it("starts on the outline, without reading the whole tree, and downloads what the preview shows", async () => {
    const { dialog, exportTree, download, outline } = await setup(async () => exportOf());
    const preview = within(dialog).getByLabelText("檔案預覽");
    expect(preview.textContent).toMatch(/^# 家用 NAS 與備份策略/);
    expect(within(dialog).getByText(`支線 ${outline.length} 條`)).toBeInTheDocument();
    expect(exportTree).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "下載" }));
    expect(download).toHaveBeenCalledWith("家用 NAS 與備份策略.md", "text/markdown", preview.textContent);
  });

  it("moves between formats with the arrow keys, reading the tree for the report; the options change the file", async () => {
    const { dialog, exportTree, download } = await setup(async () => exportOf());
    const list = formats(dialog);
    list.getByRole("radio", { name: "Markdown 大綱" }).focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(list.getByRole("radio", { name: "完整研究報告" })).toHaveAttribute("aria-checked", "true");
    expect(list.getByRole("radio", { name: "完整研究報告" })).toHaveFocus();
    await waitFor(() => expect(within(dialog).getByLabelText("檔案預覽").textContent).toContain("要不要買 NAS？"));
    expect(exportTree).toHaveBeenCalledWith(NAS_ROOT_ID, expect.anything());
    expect(within(dialog).getByLabelText("檔案預覽").textContent).toContain("二手企業碟");
    expect(within(dialog).getByText("訊息 4 則・支線 2 條・紀要 1 條・比較表 0 張")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "包含已放棄與死路支線" }));
    expect(within(dialog).getByLabelText("檔案預覽").textContent).not.toContain("二手企業碟");
    await userEvent.click(within(dialog).getByRole("button", { name: "下載" }));
    expect(download.mock.calls[0]![0]).toBe("家用 NAS 與備份策略.md");
    expect(download.mock.calls[0]![2]).not.toContain("二手企業碟");
  });

  it("previews flashcards as cards, with counts, and switches to Anki TSV", async () => {
    const { dialog, download } = await setup(async () => exportOf());
    await userEvent.click(formats(dialog).getByRole("radio", { name: "詞彙表與閃卡" }));
    expect(await within(dialog).findByText("順口問 1 張・事實 1 張・答案 0 張")).toBeInTheDocument();
    const cards = within(within(dialog).getByLabelText("檔案預覽")).getAllByRole("listitem");
    expect(cards[0]!.textContent).toContain("每月一次。");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Anki .tsv" }));
    expect(within(dialog).getByLabelText("檔案預覽").textContent).toBe("scrub 多久跑一次？\t每月一次。\n家用 NAS 與備份策略\tZFS 會自動檢查\n");
    await userEvent.click(within(dialog).getByRole("button", { name: "下載" }));
    expect(download.mock.calls[0]!.slice(0, 2)).toEqual(["家用 NAS 與備份策略 詞彙表與閃卡.tsv", "text/tab-separated-values"]);
  });

  it("says when nothing can become a card, and disables download", async () => {
    const { dialog } = await setup(async () => exportOf({ branches: [], notes: [] }));
    await userEvent.click(formats(dialog).getByRole("radio", { name: "詞彙表與閃卡" }));
    expect(await within(dialog).findByText("沒有可以做成閃卡的問答。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "下載" })).toBeDisabled();
  });

  it("warns when lines were cut at 500 messages", async () => {
    const full = Array.from({ length: 500 }, (_, index) => msg(`x${index}`, NAS_ROOT_ID, index + 1, "user", "x"));
    const { dialog } = await setup(async () => exportOf({ truncated: true, messagesByLine: { [NAS_ROOT_ID]: full } }));
    await userEvent.click(formats(dialog).getByRole("radio", { name: "ADR 架構決策紀錄" }));
    expect(await within(dialog).findByText("有 1 條線超過 500 則，只匯出前 500 則。報告開頭會註明。")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("檔案預覽").textContent).toMatch(/^> 有些線超過 500 則訊息/);
  });

  it("says the tree could not be read, offers a retry, and keeps download off", async () => {
    let fail = true;
    const { dialog, exportTree } = await setup(async () => {
      if (fail) throw new Error("offline");
      return exportOf();
    });
    await userEvent.click(formats(dialog).getByRole("radio", { name: "完整備份" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("讀不到整段對話，沒辦法匯出。");
    expect(within(dialog).getByRole("button", { name: "下載" })).toBeDisabled();
    fail = false;
    await userEvent.click(within(dialog).getByRole("button", { name: "再試一次" }));
    await waitFor(() => expect(within(dialog).getByLabelText("檔案預覽").textContent).toContain('"rootLineId"'));
    expect(exportTree).toHaveBeenCalledTimes(2);
  });
});
