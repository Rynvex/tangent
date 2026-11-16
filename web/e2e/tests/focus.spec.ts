import { expect, test, type Page } from "@playwright/test";
import { composer, replies, sidePanel, toast } from "./flows";
import { expectAccessible, shoot } from "./helpers";

/**
 * Focus mode, phase 1 (docs/design/FOCUS_MODE.md §12), against the mock
 * (scenario 1): side by side from 1024 up, tabs below; the node panel, the
 * map in step with the chat, a focused subtree, notes on a node and 帶進這一輪.
 */

const ZFS = { id: "nas-b1", purpose: "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異" };
const DISKS = { id: "nas-b3", purpose: "4TB 與 8TB 硬碟的每 TB 成本與保固" };

const map = (page: Page) => page.getByRole("region", { name: "地圖" });
const panel = (page: Page) => page.getByRole("region", { name: "節點面板" });
const node = (page: Page, id: string) => page.locator(`[data-tg-map-node="${id}"] > button`).first();
/** The conversation's header (inside <main>, so not a banner landmark). */
const header = (page: Page) => page.locator("main > header");
const focusButton = (page: Page) => header(page).getByRole("button", { name: "專注" });
const newConversation = (page: Page) => page.getByRole("button", { name: "新對話", exact: true });

/** The first page of a run waits for Vite's cold compile and the lazily loaded focus chunk. */
const FIRST_LOAD_MS = 30_000;

/** Opens the demo and waits until focus mode (or, without it, the composer) is there. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const ready = url.includes("focus=1") ? page.locator("[data-tg-map-canvas], [role=radiogroup]").first() : composer(page);
  await expect(ready).toBeVisible({ timeout: FIRST_LOAD_MS });
}

test.describe("focus mode (FOCUS_MODE.md)", () => {
  test.describe.configure({ timeout: 60_000 });

  test("⌘⇧F puts chat and map side by side, folding the list and side panel away; again restores them", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/");
    await expect(composer(page)).toBeVisible();
    await expect(sidePanel(page)).toBeVisible();
    await expect(newConversation(page)).toBeVisible();
    await composer(page).click();
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await expect(map(page)).toBeVisible();
    await expect(focusButton(page)).toHaveAttribute("aria-pressed", "true");
    await expect(sidePanel(page)).toHaveCount(0);
    await expect(newConversation(page)).toHaveCount(0);
    await expect(page.getByRole("separator", { name: "調整對話與地圖的寬度" })).toHaveAttribute("aria-valuenow", "50");
    await shoot(page, "focus", "1440-enter");
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await expect(map(page)).toHaveCount(0);
    await expect(sidePanel(page)).toBeVisible();
    await expect(newConversation(page)).toBeVisible();
  });

  test("a click chooses a node and leaves the chat where it is; 到這條 enters it with the map still open", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await node(page, ZFS.id).click();
    await expect(panel(page).getByRole("heading", { name: ZFS.purpose })).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await expect(page.getByText("你在這裡").first()).toBeVisible();
    await shoot(page, "focus", "1440-panel");
    await panel(page).getByRole("button", { name: "到這條" }).click();
    await expect(header(page)).toContainText(ZFS.purpose);
    await expect(map(page)).toBeVisible();
    await expect(node(page, ZFS.id)).toHaveAttribute("aria-current", "location");
    await expectAccessible(page);
  });

  test("double-click enters; Esc closes the panel without leaving focus mode", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await node(page, DISKS.id).click();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(map(page)).toBeVisible();
    await node(page, DISKS.id).dblclick();
    await expect(header(page)).toContainText(DISKS.purpose);
  });

  test("a focused subtree fades the rest, says it only changes the map, and warns outside it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await node(page, ZFS.id).click();
    await map(page).getByRole("button", { name: "聚焦子樹" }).click();
    await expect(map(page).getByRole("button", { name: `聚焦：${ZFS.purpose}` })).toHaveAttribute("title", "只影響地圖顯示，不影響 AI。");
    await expect(page.locator(`[data-tg-map-node="${DISKS.id}"]`)).toHaveAttribute("data-tg-dimmed", "");
    await expect(page.locator(`[data-tg-map-node="${ZFS.id}"]`)).not.toHaveAttribute("data-tg-dimmed", "");
    await node(page, DISKS.id).dblclick();
    await expect(map(page).getByText("你在聚焦範圍外")).toBeVisible();
    await map(page).getByRole("button", { name: "改聚焦這裡" }).click();
    await expect(page.locator(`[data-tg-map-node="${DISKS.id}"]`)).not.toHaveAttribute("data-tg-dimmed", "");
    await shoot(page, "focus", "1440-subtree");
  });

  test("a note written on a node names it as the source on the notes page", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await node(page, DISKS.id).click();
    await panel(page).getByRole("button", { name: "新增紀要（待確認）" }).click();
    await expect(panel(page).getByRole("radio", { name: "待確認" })).toBeChecked();
    await panel(page).getByRole("textbox").last().fill("保固要看 RMA 流程");
    await panel(page).getByRole("textbox").last().press("Enter");
    // The new note's row (the add box may still be closing for a moment).
    await expect(panel(page).getByRole("listitem").filter({ hasText: "保固要看 RMA 流程" })).toBeVisible();
    await expect(page.locator(`[data-tg-map-node="${DISKS.id}"] [data-tg-note-count]`)).toHaveText("1");
    await panel(page).getByRole("button", { name: /^看全部紀要/ }).click();
    const notes = sidePanel(page);
    await expect(notes.getByText("保固要看 RMA 流程")).toBeVisible();
    await expect(notes.getByRole("button", { name: new RegExp(DISKS.purpose) }).first()).toBeVisible();
  });

  test("帶進這一輪 puts the note first in the composer and sends nothing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await expect(replies(page).first()).toBeVisible();
    const before = await replies(page).count();
    await composer(page).fill("我想再確認");
    await node(page, ZFS.id).click();
    const item = panel(page).locator("li").filter({ hasText: "ECC 記憶體是否必要" });
    await item.getByRole("button", { name: "這則紀要的動作" }).click();
    await page.getByRole("menuitem", { name: "帶進這一輪" }).click();
    await expect(composer(page)).toHaveValue(`關於「${ZFS.purpose}」的筆記：ECC 記憶體是否必要\n\n我想再確認`);
    await expect(composer(page)).toBeFocused();
    await expect(toast(page)).toHaveText("已帶進這一輪，還沒送出。");
    await expect(replies(page)).toHaveCount(before);
  });

  test("the split keeps the chat ≥ 420 px and the map ≥ 360 px; the panel moves to the bottom on a narrow map", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    const separator = page.getByRole("separator", { name: "調整對話與地圖的寬度" });
    await separator.focus();
    await page.keyboard.press("End");
    await expect(page.getByRole("status").filter({ hasText: "地圖已到最窄 360px" })).toBeVisible();
    await node(page, DISKS.id).click();
    const box = await panel(page).boundingBox();
    const mapBox = await map(page).boundingBox();
    expect(box && mapBox && box.width).toBeGreaterThan((mapBox?.width ?? 0) * 0.8);
    await page.keyboard.press("Escape");
    await separator.dblclick();
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
  });

  test("375: 對話｜地圖 tabs, the panel as a sheet, entering a line goes back to the chat", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await open(page, "/?focus=1");
    const tabs = page.getByRole("radiogroup", { name: "對話或地圖" });
    await expect(tabs.getByRole("radio", { name: "對話" })).toBeChecked();
    await tabs.getByRole("radio", { name: "地圖" }).click();
    await expect(map(page)).toBeVisible();
    await expect(map(page).getByRole("button", { name: "多選" })).toHaveCount(0);
    await node(page, DISKS.id).click();
    const sheet = page.getByRole("dialog", { name: "節點面板" });
    await expect(sheet.getByRole("heading", { name: DISKS.purpose })).toBeVisible();
    await shoot(page, "focus", "375-sheet");
    await sheet.getByRole("button", { name: "到這條" }).click();
    await expect(tabs.getByRole("radio", { name: "對話" })).toBeChecked();
    await expect(header(page)).toContainText(DISKS.purpose.slice(0, 6));
  });

  test("a viewer sees the panel as text only", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1&as=viewer");
    await node(page, DISKS.id).click();
    await expect(panel(page).getByText("你只有檢視權限。")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "改標題" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "結束並帶回" })).toHaveCount(0);
  });

  test("B13: a memo on a node is not for the AI, counts on the map, and can be deleted and brought back", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await node(page, DISKS.id).click();
    await panel(page).getByRole("radio", { name: /^備忘（不給 AI）/ }).click();
    const memos = panel(page).getByRole("region", { name: /^備忘（不給 AI）/ });
    await expect(memos.getByText("還沒有備忘。寫下不給 AI 的想法；看得到這段對話的人都看得到。")).toBeVisible();
    await memos.getByRole("button", { name: "新增備忘" }).click();
    await memos.getByRole("textbox", { name: "備忘內容" }).fill("問店家 RMA 要寄去哪裡");
    await memos.getByRole("textbox", { name: "備忘內容" }).press("Enter");
    await expect(memos.getByRole("listitem").filter({ hasText: "問店家 RMA 要寄去哪裡" })).toBeVisible();
    await expect(page.locator(`[data-tg-map-node="${DISKS.id}"] [data-tg-note-count]`)).toHaveText("1");
    await expect(node(page, DISKS.id)).toHaveAccessibleName(/1 則備忘/);
    await shoot(page, "focus", "1440-memo");
    await memos.getByRole("button", { name: "這則備忘的動作" }).click();
    await page.getByRole("menuitem", { name: "刪除" }).click();
    await expect(memos.getByText("已刪除一則備忘。")).toBeVisible();
    await memos.getByRole("button", { name: "復原" }).click();
    await expect(memos.getByText("問店家 RMA 要寄去哪裡")).toBeVisible();
  });

  test("B13: an ended branch can be renamed from its panel; the map follows", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await node(page, ZFS.id).click();
    await panel(page).getByRole("button", { name: "改標題" }).click();
    await expect(panel(page).getByText("改名後，主線之後的回合裡，這張結論卡的來源會用新名字。")).toBeVisible();
    const box = panel(page).getByRole("textbox", { name: "支線目的" });
    await box.fill("ZFS 還是 Btrfs");
    await box.press("Enter");
    await expect(panel(page).getByRole("heading", { name: "ZFS 還是 Btrfs" })).toBeVisible();
    await expect(page.locator(`[data-tg-map-node="${ZFS.id}"]`)).toContainText("ZFS 還是 Btrfs");
  });

  test("B13: 記成備忘 from a selection writes a memo on the line on screen", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1");
    await expect(replies(page).first()).toBeVisible();
    const paragraph = replies(page).last().locator("p").first();
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.getByRole("toolbar").getByRole("button", { name: "記成備忘" }).click();
    await expect(toast(page)).toHaveText("已記成備忘（不會給 AI）。");
    await node(page, "__main__").click();
    await panel(page).getByRole("radio", { name: /^備忘（不給 AI）/ }).click();
    await expect(panel(page).getByRole("region", { name: /^備忘（不給 AI）/ }).getByRole("listitem")).toHaveCount(1);
  });

  test("only the core: no relations, groups or argument types in the panel or the map", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/?focus=1&features=core");
    await node(page, ZFS.id).click();
    await expect(panel(page).getByRole("heading", { name: ZFS.purpose })).toBeVisible();
    await expect(panel(page).getByText("關聯")).toHaveCount(0);
    await expect(map(page).getByRole("button", { name: "群組" })).toHaveCount(0);
  });
});
