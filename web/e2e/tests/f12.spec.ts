import { expect, test, type Locator, type Page } from "@playwright/test";
import { composer, replies, sidePanel, turn } from "./flows";
import { expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { branchBar, backToMain, openTab } from "./f5-flows";

/**
 * F12 (13_FRONTEND_F12.md, design 2026-10-30) on the mock: ① an aside opened
 * in place (S1) and the words branches came from (S2); ② the side panel's
 * width and the map's first fit (S3), the inbox's filter and 忽略全部 (S5);
 * ③ a conclusion card edited and followed up (S6, B17).
 */

const Q = "theme=light&lang=zh-TW";
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });
const message = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
const CARD_BRANCH = "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異";

test.beforeEach(({}, info) => test.skip(isApi(info), "F12's flows run on the mock's scenario"));

/** Selects `text` inside `element` (one text node). */
async function selectIn(element: Locator, text: string): Promise<void> {
  await element.evaluate((node, wanted) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const at = current.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(current, at);
      range.setEnd(current, at + wanted.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      return;
    }
    throw new Error(`"${wanted}" not found`);
  }, text);
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("① S1 + S2: 秒問解釋 answers in place under the message, keeps its answer once, and the words become anchors", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    // S2: a branch's words in the reply, dashed, with a preview on hover; a click enters the branch.
    const words = message(page, "nas-m17").locator('[data-tg-excerpt="nas-b3"]');
    await expect(words).toHaveText(/兩者都容許壞一顆碟/);
    await words.hover();
    const preview = page.getByRole("tooltip");
    await expect(preview).toContainText("4TB 與 8TB 硬碟的每 TB 成本與保固");
    await expect(preview).toContainText("點一下或 Enter 進入支線");
    // Fully shown, not clipped by the row (it is in a portal): its last line is in view.
    await expect(preview.getByText("點一下或 Enter 進入支線")).toBeInViewport();
    await shoot(page, "F12", "excerpt-preview-1440");
    await words.click();
    await expect(branchBar(page)).toContainText("4TB 與 8TB 硬碟的每 TB 成本與保固");
    await backToMain(page);

    // S1: the aside opens in place; the reading place stays on the main line.
    const reply = message(page, "nas-m19");
    await reply.scrollIntoViewIfNeeded();
    await selectIn(reply, "vdev");
    await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "秒問解釋" }).click();
    const inline = page.getByRole("region", { name: "順口問：了解：vdev" });
    await expect(inline).toBeVisible();
    await expect(path(page)).not.toContainText("了解：vdev");
    await expect(inline.getByText(/^你：/)).toBeVisible();
    // F19 (追加 B.2): 記進紀要 is in the card's 「⋯」 now; the footer keeps 保留, 接著問, 存進名詞表 and 丟掉.
    const more = inline.getByRole("button", { name: "這則順口問的其他動作" });
    await expect(more).toBeVisible({ timeout: 20_000 });
    await expect(inline).toContainText("天後清除");
    await more.click();
    await page.getByRole("menuitem", { name: "記進紀要", exact: true }).click();
    await more.click();
    await expect(page.getByRole("menuitem", { name: "已記進紀要" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expectAccessible(page, MODERATE, '[data-tg-aside-inline]');
    await shoot(page, "F12", "aside-inline-1440");
    // Its fork row says it is open here; 收合 takes it away, the row says it can open here again.
    const fork = reply.locator("[data-tg-fork]").first();
    await fork.click();
    const row = page.locator('[data-tg-fork-row]').filter({ hasText: "了解：vdev" });
    await expect(row).toContainText("原地展開中");
    await inline.getByRole("button", { name: "收合" }).last().click();
    await expect(inline).toHaveCount(0);
    await expect(row).toContainText("已回答・在這裡展開");
    // The selected word is an anchor of the aside now: Enter opens it in place again.
    const anchor = reply.locator("[data-tg-excerpt]").filter({ hasText: "vdev" });
    await anchor.focus();
    await expect(page.getByRole("tooltip")).toContainText("點一下或 Enter 在這裡展開");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "順口問：了解：vdev" })).toBeVisible();
    await page.getByRole("region", { name: "順口問：了解：vdev" }).getByRole("button", { name: "這則順口問的其他動作" }).click();
    await expect(page.getByRole("menuitem", { name: "已記進紀要" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Esc collapses it.
    await page.getByRole("region", { name: "順口問：了解：vdev" }).getByRole("heading").press("Escape");
    await expect(page.getByRole("region", { name: "順口問：了解：vdev" })).toHaveCount(0);
  });

  test("② S3 + S5: the side panel resizes (keys, drag, kept), the map fits on first open, the inbox filters and dismisses all", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const side = sidePanel(page);
    const separator = page.getByRole("separator", { name: "調整側欄寬度" });
    await expect(separator).toHaveAttribute("aria-valuenow", "360");
    await expect(separator).toHaveAttribute("aria-valuemax", "600");
    await separator.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "376");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "312");
    await page.keyboard.press("End");
    await expect(separator).toHaveAttribute("aria-valuenow", "600");
    await page.keyboard.press("Home");
    await expect(separator).toHaveAttribute("aria-valuenow", "280");
    await page.keyboard.press("Enter");
    await expect(separator).toHaveAttribute("aria-valuenow", "360");
    // Drag 120 px to the left: 480.
    const box = (await separator.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2);
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", "480");
    expect(Math.round((await side.boundingBox())!.width)).toBe(480);
    await shoot(page, "F12", "side-resize-480-1440");
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem("tangent:side-width:v1"))).toBe("480");
    await page.reload();
    await expect(page.getByRole("separator", { name: "調整側欄寬度" })).toHaveAttribute("aria-valuenow", "480");
    await page.keyboard.press("Escape");
    await page.getByRole("separator", { name: "調整側欄寬度" }).focus();
    await page.keyboard.press("Enter");

    // S3: the map fits on first open (the tree is wider than the panel); zooming by hand ends the note.
    await openTab(page, "結構");
    await side.getByRole("radio", { name: "地圖" }).click();
    await expect(side.getByText("初次打開，已自動符合")).toBeVisible();
    const zoom = side.getByRole("status", { name: /縮放/ });
    expect(Number((await zoom.textContent())?.replace("%", ""))).toBeLessThan(100);
    await shoot(page, "F12", "map-auto-fit-1440");
    await side.getByRole("button", { name: "放大" }).click();
    await expect(side.getByText("初次打開，已自動符合")).toHaveCount(0);

    // S5: an AI suggestion to dismiss, then the filter and 忽略全部.
    await turn(page, "[probe:suggest] 幫我看看還缺什麼");
    await openTab(page, "待處理");
    const chips = side.getByRole("radiogroup", { name: "篩選" });
    await expect(chips.getByRole("radio", { name: "全部" })).toHaveAttribute("aria-checked", "true");
    const ai = chips.getByRole("radio", { name: /^AI 建議 \(\d+\)$/ });
    const count = Number(/\((\d+)\)/.exec((await ai.textContent()) ?? "")?.[1] ?? 0);
    expect(count).toBeGreaterThan(0);
    await ai.click();
    await expect(side.getByRole("heading", { name: /停車場/ })).toHaveCount(0);
    await expectAccessible(page, MODERATE, '[role="radiogroup"][aria-label="篩選"]');
    await shoot(page, "F12", "inbox-filter-1440");
    await side.getByRole("button", { name: `忽略全部 ${count} 條 AI 建議` }).click();
    await expect(side.getByText(`已忽略 ${count} 條 AI 建議`)).toBeVisible();
    await expect(chips.getByRole("radio", { name: "AI 建議 (0)" })).toBeVisible();
    await expect(side.getByText("沒有 AI 建議。有新建議時會出現在這裡。")).toBeVisible({ timeout: 8000 });
    await expect(side.getByText(`已忽略 ${count} 條 AI 建議`)).toHaveCount(0);
  });

  test("③ S6: a merged card is edited (已修改・下一輪帶入) and followed up from; the follow-up forks from the card", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const card = page.getByRole("region", { name: "結論卡" }).or(page.locator('section[aria-label="結論卡"]')).first();
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: "編輯結論" }).click();
    const edit = page.getByRole("dialog", { name: "編輯結論" });
    await expect(edit).toContainText(`支線「${CARD_BRANCH}」的結論卡`);
    const conclusion = edit.getByRole("textbox", { name: "結論（必填）" });
    await expect(conclusion).toBeFocused();
    await expect(edit.getByRole("button", { name: "儲存" })).toBeDisabled();
    await conclusion.fill("ZFS mirror；每月 scrub 一次，換碟用 zpool replace。");
    await edit.getByRole("button", { name: "新增一項" }).click();
    await edit.getByRole("textbox", { name: "待解 2" }).fill("要不要買 UPS");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F12", "card-edit-1440");
    await edit.getByRole("button", { name: "儲存" }).click();
    await expect(edit).toBeHidden();
    await expect(card).toContainText("ZFS mirror；每月 scrub 一次，換碟用 zpool replace。");
    await expect(card).toContainText("已修改・下一輪帶入");
    // B17.1: the pill comes from the card's own edit time (meta.editedAt), nothing is kept in this browser.
    await expect(card.locator('[data-tg-card-state="editedPending"]')).toHaveText("已修改・下一輪帶入");
    expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith("tangent:card-edits")))).toEqual([]);

    // 繼續追問: a new branch anchored on the card; the dialog says the original stays merged and offers its open questions.
    await card.getByRole("button", { name: "繼續追問" }).click();
    const dialog = page.getByRole("dialog", { name: "開支線" });
    await expect(dialog).toContainText(`會從主線這張結論卡開一條新支線；「${CARD_BRANCH}」維持已帶回。`);
    await expect(dialog).toContainText("ZFS mirror；每月 scrub 一次");
    const chip = dialog.getByRole("radio", { name: "待解：ECC 記憶體是否必要" });
    await expect(chip).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("radio", { name: "待解：要不要買 UPS" })).toBeVisible();
    await shoot(page, "F12", "card-follow-up-1440");
    await dialog.getByRole("button", { name: "開啟支線並送出問題" }).click();
    await expect(dialog).toBeHidden();
    await expect(branchBar(page)).toContainText("ECC 記憶體是否必要");
    await expect(composer(page)).toBeVisible();
    await backToMain(page);
    const forks = message(page, "nas-c1").locator("[data-tg-fork]");
    await expect(forks).toContainText("從這張結論卡追問");
    // Edited again after the follow-up opened: its row says 前提已更新 (decision #6).
    await card.getByRole("button", { name: "編輯結論" }).click();
    await page.getByRole("dialog", { name: "編輯結論" }).getByRole("textbox", { name: "影響" }).fill("先不買 ECC。");
    await page.getByRole("dialog", { name: "編輯結論" }).getByRole("button", { name: "儲存" }).click();
    // The follow-up's answer toast and the save toast stack, never on top of each other.
    const replyToast = page.locator("[data-tg-reply-toast]");
    const frameToast = page.locator('div.pointer-events-none[role="status"][aria-live="polite"] > span');
    if ((await replyToast.count()) > 0 && (await frameToast.count()) > 0) {
      const [a, b] = [(await replyToast.boundingBox())!, (await frameToast.boundingBox())!];
      expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    await forks.click();
    await expect(page.locator("[data-tg-fork-row]").filter({ hasText: "ECC 記憶體是否必要" }).getByRole("img", { name: "前提已更新" })).toBeVisible();
    await shoot(page, "F12", "card-forks-1440");
  });
  test("④ S4 + S7: a slow reply shows its stage and stops from the label row; the token meter opens the context breakdown", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const before = await replies(page).count();
    await composer(page).fill("[fake:slow] 慢慢想");
    await composer(page).press("Enter");
    const pending = replies(page).nth(before);
    await expect(pending.locator("[data-tg-reply-stage]")).toBeVisible();
    await expect(pending).toContainText("正在準備上下文並傳送…");
    await shoot(page, "F12", "reply-stage-1440");
    await pending.getByRole("button", { name: "停止生成" }).click();
    await expect(pending).toContainText("已停止・沒有回答");
    // S7: the meter is a button; the breakdown lists the next turn's parts and leads to the full preview.
    const meter = page.locator("[data-tg-usage]");
    await meter.click();
    await expect(meter).toHaveAttribute("aria-pressed", "true");
    const breakdown = page.getByRole("dialog", { name: "下一輪會送出的上下文" });
    await expect(breakdown).toBeVisible();
    await expect(breakdown.getByRole("listitem").first()).toBeVisible();
    await shoot(page, "F12", "usage-breakdown-1440");
    await page.keyboard.press("Escape");
    await expect(breakdown).toBeHidden();
    await expect(meter).toBeFocused();
    await meter.click();
    await page.getByRole("dialog", { name: "下一輪會送出的上下文" }).getByRole("button", { name: "送出前預覽完整內容" }).click();
    await expect(page.getByRole("region", { name: "送出前預覽" })).toBeVisible();
  });
});
