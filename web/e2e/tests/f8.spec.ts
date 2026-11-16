import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { composer, replies, sidePanel, toast, turn } from "./flows";
import { argBadge, expectAccessible, isApi, messageAction, MODERATE, shoot } from "./helpers";
import { branchBar, openTab, outlineRow } from "./f5-flows";

/**
 * F8 (6_FRONTEND_F8.md, phases 1–3) on the mock, scenario 1 (家用 NAS): the
 * message actions and their 「更多動作」, 修改並分岔 and 分岔重答, the
 * cross-model diverge, the in-tree search, the shortcut list, the list's pins
 * and footer, the export dialog, parking a reply's list, the review card of
 * AI's argument types, 前提已更新 and the Feynman check — at 1440, 420
 * (embedded) and 375 (phone).
 */

const Q = "theme=light&lang=zh-TW";
const NAS = "nas";
const ZFS = { id: "nas-b1", purpose: "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異" };

const said = (page: Page, text: string) => page.locator("[data-tg-message]").filter({ hasText: text });
const message = (page: Page, text: string) => said(page, text).first();
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });
const menu = (page: Page) => page.getByRole("menu").first();

/** Scenario 1's main line, loaded (its replies on screen). */
async function openNas(page: Page, query = Q): Promise<void> {
  await page.goto(`/?${query}&line=${NAS}`);
  await expect(replies(page).first()).toBeVisible();
}

test.beforeEach(({}, info) => test.skip(isApi(info), "F8's flows run on the mock's scenario (the reference server has the routes; its flows are the backend's smoke)"));

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("S1: three actions in view and the rest in 「更多動作」; the first message offers a new conversation instead of 修改並分岔", async ({ page }, info) => {
    await openNas(page);
    const reply = replies(page).last();
    await reply.hover();
    const bar = reply.getByRole("toolbar", { name: "訊息動作" });
    await expect(bar.getByRole("button")).toHaveText(["從這則開支線", "停車", "", ""]);
    await bar.getByRole("button", { name: "更多動作" }).click();
    await expect(menu(page).getByRole("menuitem")).toHaveText(["分岔重答（可換模型）…", "給我幾個方向…", "記進紀要", "記成備忘", "存進名詞表", "從這則抽成支線…", "從這裡開新對話", "關聯…", "從這則起折疊…", "釘選", "標論證類型…"]);
    await expectAccessible(page, MODERATE, '[role="menu"]');
    await shoot(page, "F8", "s1-menu-1440");
    await page.keyboard.press("Escape");
    await expect(bar.getByRole("button", { name: "更多動作" })).toBeFocused();
    // The line's first message has nowhere to branch from (decision #10).
    const first = page.locator("div[data-tg-message]").first();
    await first.hover();
    await first.getByRole("button", { name: "更多動作" }).click();
    await expect(menu(page).getByRole("menuitem", { name: "修改並分岔…" })).toHaveAttribute("aria-disabled", "true");
    await expect(menu(page)).toContainText("第一則訊息沒有可以分岔的地方。");
    await menu(page).getByRole("menuitem", { name: "改問，開成新對話…" }).click();
    const spinoff = page.getByRole("dialog", { name: "獨立成新對話" });
    await spinoff.getByRole("textbox", { name: "新對話的標題" }).fill("NAS, asked again");
    await spinoff.getByRole("button", { name: "建立新對話" }).click();
    await expect(spinoff).toBeHidden();
    // The question waits in the new conversation's composer, unsent.
    await expect(composer(page)).toHaveValue(/^需求大概清楚了/);
    await expect(composer(page)).toBeFocused();
    expect(info.project.name).toBe("mock");
  });

  test("S6: 修改並分岔 opens an alternative branch from the message before and sends the edited text there", async ({ page }) => {
    await openNas(page);
    const own = message(page, "好，那就 ZFS mirror");
    await messageAction(own, "修改並分岔");
    const dialog = page.getByRole("dialog", { name: "修改並分岔" });
    await expect(dialog).toContainText("會從 #4 開一條「另一條路」支線");
    const box = dialog.getByRole("textbox", { name: "改成" });
    await expect(box).toBeFocused();
    await expect(dialog.getByRole("button", { name: "開支線並送出" })).toHaveAttribute("aria-disabled", "true");
    await box.fill("好，那就 Btrfs RAID1。ECC 的事等等再說。");
    await expect(dialog.getByRole("textbox", { name: "支線目的" })).toHaveValue("改問：好，那就 Btrfs RAID1。ECC 的事等等再說。");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", "s6-edit-1440");
    await dialog.getByRole("button", { name: "開支線並送出" }).click();
    await expect(dialog).toBeHidden();
    await expect(branchBar(page)).toContainText("改問：好，那就 Btrfs RAID1");
    await expect(said(page, "好，那就 Btrfs RAID1。ECC 的事等等再說。")).toBeVisible();
    await expect(replies(page)).toHaveCount(1);
  });

  test("S7: 分岔重答 re-asks the turn's question in a branch on the model picked", async ({ page }) => {
    await openNas(page);
    await messageAction(message(page, "好。紀要已記下"), "分岔重答（可換模型）…");
    const dialog = page.getByRole("dialog", { name: "分岔重答" });
    await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
    await dialog.getByRole("radio", { name: /claude-haiku-4-5/ }).check();
    await expect(dialog.getByRole("textbox", { name: "支線目的" })).toHaveValue(/^重答（claude-haiku-4-5）：好，那就 ZFS mirror/);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "開支線並重答" }).click();
    await expect(dialog).toBeHidden();
    await expect(branchBar(page)).toContainText("重答（claude-haiku-4-5）");
    // The question is the branch's first message; the AI saw it once.
    await expect(page.locator("div[data-tg-message]").first()).toContainText("好，那就 ZFS mirror。ECC 的事等等再說。");
  });

  test("S8: 跨模型平行比較 opens one branch per model and remembers the choice", async ({ page }) => {
    await openNas(page);
    const last = replies(page).last();
    await messageAction(last, "給我幾個方向…");
    let dialog = page.getByRole("dialog", { name: "給我幾個方向" });
    await dialog.getByRole("radiogroup", { name: "發散方式" }).getByRole("radio", { name: "跨模型平行比較" }).click();
    dialog = page.getByRole("dialog", { name: "跨模型平行比較" });
    await expect(dialog.getByRole("textbox", { name: "問題" })).toHaveValue("那備份呢？本地快照之外，異地要放哪？");
    await expect(dialog.getByRole("button", { name: "開 0 條支線" })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("checkbox", { name: /claude-haiku-4-5/ }).check();
    await dialog.getByRole("checkbox", { name: /claude-sonnet-4-5/ }).check();
    await expect(dialog).toContainText("支線：那備份呢？本地快照之外，異地要放哪？ · claude-haiku-4-5");
    await expect(dialog.getByRole("checkbox", { name: "建好後在每條支線送出這個問題" })).toBeChecked();
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", "s8-models-1440");
    await dialog.getByRole("button", { name: "開 2 條支線" }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    const marker = page.getByRole("region", { name: "發散：2 個方向" });
    await expect(marker).toContainText("claude-haiku-4-5");
    await expect(marker).toContainText("claude-sonnet-4-5");
    // The last way used comes back next time (S8: 記住上次的選擇).
    await messageAction(replies(page).last(), "給我幾個方向…");
    await expect(page.getByRole("dialog", { name: "跨模型平行比較" })).toBeVisible();
  });

  test("S3: ⌘F searches this conversation; Enter goes into a branch, and a folded message's fold opens until the search closes", async ({ page }) => {
    await openNas(page);
    // Fold #1–#4 first.
    await messageAction(page.locator("div[data-tg-message]").first(), "從這則起折疊…");
    const fold = page.getByRole("dialog", { name: "折疊成摘要" });
    await fold.getByRole("combobox", { name: "折疊到" }).selectOption({ index: 2 });
    await fold.getByRole("textbox", { name: /^摘要/ }).fill("問了預算與需求");
    await fold.getByRole("button", { name: "折疊" }).click();
    await expect(page.locator("section[data-tg-fold]")).toHaveCount(1);
    await composer(page).focus();
    await page.keyboard.press("Control+f");
    const search = page.getByRole("search", { name: "在對話內搜尋" });
    const box = search.getByRole("combobox", { name: "在對話內搜尋" });
    await expect(box).toBeFocused();
    await box.fill("s");
    await expect(search).toContainText("至少打 2 個字");
    await box.fill("scrub");
    const results = page.getByRole("listbox", { name: "在對話內搜尋" });
    await expect(results.getByRole("group", { name: "訊息" }).getByRole("option").first()).toBeVisible();
    await expectAccessible(page, MODERATE, '[role="search"]');
    await shoot(page, "F8", "s3-search-1440");
    await box.press("Enter");
    await expect(path(page)).toContainText("ZFS mirror");
    // A message in the fold: the fold opens while the bar is open.
    await box.fill("預算");
    const folded = results.getByRole("option").filter({ hasText: /在折疊 #1–#\d+ 裡/ }).first();
    await expect(folded).toBeVisible();
    await folded.click();
    const block = page.locator("section[data-tg-fold]").first();
    await expect(block.getByRole("button", { name: /^已折疊 #1–#\d+/ })).toHaveAttribute("aria-expanded", "true");
    await search.getByRole("button", { name: "關閉搜尋" }).click();
    await expect(block.getByRole("button", { name: /^已折疊 #1–#\d+/ })).toHaveAttribute("aria-expanded", "false");
  });

  test("S4: ? lists the shortcuts by group, as bound now; Esc closes", async ({ page }) => {
    await openNas(page);
    await expect(composer(page)).toBeVisible();
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Shift+?");
    const dialog = page.getByRole("dialog", { name: "快捷鍵" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toContainText(["導覽", "支線"]);
    await expect(dialog).toContainText("在對話內搜尋");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", "s4-shortcuts-1440");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("S5: pin a conversation to the top, rename it in place; 回顧 and 記憶庫 stay under the list", async ({ page }) => {
    await openNas(page);
    const list = page.getByRole("navigation", { name: "對話" });
    const row = list.getByRole("button", { name: /日本行程/ }).first();
    await row.hover();
    await list.getByRole("button", { name: /日本行程.*的動作/ }).click();
    await page.getByRole("menuitem", { name: /置頂對話/ }).click();
    const pinned = list.getByRole("region", { name: "置頂" }).or(list.locator("section").filter({ has: page.getByRole("heading", { name: "置頂" }) }));
    await expect(pinned).toContainText("日本行程");
    await list.getByRole("button", { name: /日本行程.*的動作/ }).click();
    await page.getByRole("menuitem", { name: "重新命名…" }).click();
    const field = list.getByRole("textbox").first();
    await field.fill("大阪四天三夜");
    await field.press("Enter");
    await expect(list.getByText("大阪四天三夜")).toBeVisible();
    await expect(list.getByRole("button", { name: /^回顧/ })).toBeVisible();
    await expect(list.getByRole("button", { name: "記憶庫" })).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "F8", "s5-list-1440");
  });

  test("S9: the export dialog previews exactly what is downloaded: the full report, the ADR and the flashcards", async ({ page }) => {
    await openNas(page);
    await page.locator("main > header").getByRole("button", { name: /的動作$/ }).click();
    await page.getByRole("menuitem", { name: "匯出…" }).click();
    const dialog = page.getByRole("dialog", { name: /^匯出「家用 NAS/ });
    const formats = dialog.getByRole("radiogroup", { name: "格式" });
    await formats.getByRole("radio", { name: "完整研究報告" }).click();
    await expect(dialog.locator("pre").first()).toContainText("家用 NAS 與備份策略", { timeout: 15_000 });
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", "s9-report-1440");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下載" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    expect(await readFile((await file.path())!, "utf8")).toContain("ZFS mirror");
    await formats.getByRole("radio", { name: "ADR 架構決策紀錄" }).click();
    await expect(dialog.locator("pre").first()).toContainText("ADR");
    await formats.getByRole("radio", { name: "詞彙表與閃卡" }).click();
    await expect(dialog).toContainText("scrub 多久跑一次？");
  });

  test("S11: a reply's list goes to the parking lot, as many as there is room for, each editable", async ({ page }, info) => {
    await openNas(page);
    await turn(page, "[fake:list] 接下來要查什麼？");
    await messageAction(replies(page).last(), "將清單存入停車場（4 項）…");
    const dialog = page.getByRole("dialog", { name: "把清單存入停車場" });
    await expect(dialog.getByRole("textbox", { name: /^第 \d 項$/ })).toHaveCount(4);
    await expect(dialog.getByRole("textbox", { name: "第 1 項" })).toHaveValue("UPS 的續航時間");
    await expect(dialog.getByRole("textbox", { name: "第 3 項" })).toHaveValue("備份到 Backblaze B2 的月費");
    await dialog.getByRole("textbox", { name: "第 2 項" }).fill("硬碟保固幾年");
    await dialog.getByRole("checkbox", { name: "存入第 4 項" }).uncheck();
    await expect(dialog.getByRole("status")).toContainText("存入 3 顆後");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", `s11-seeds-1440-${info.project.name}`);
    await dialog.getByRole("button", { name: "存入 3 顆" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page)).toContainText("已存 3 顆到停車場。");
    await page.getByRole("button", { name: "看停車場" }).click();
    await expect(sidePanel(page).getByText("硬碟保固幾年")).toBeVisible();
  });

  test("S2: AI's draft types wait on one card in 待處理; 全部確認 confirms them and 復原 puts them back", async ({ page }) => {
    await openNas(page);
    await turn(page, "再問一題");
    const badge = argBadge(replies(page).last());
    await expect(badge).toHaveAttribute("data-tg-arg-badge", "draft", { timeout: 20_000 });
    await openTab(page, "待處理");
    const card = sidePanel(page).getByRole("region", { name: "論證類型待確認" });
    await expect(card).toContainText(/AI 幫這段對話的 \d+ 則訊息標了論證類型/);
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
    await card.getByRole("button", { name: "全部確認" }).click();
    await expect(sidePanel(page).getByText(/已確認 \d+ 則論證類型/)).toBeVisible();
    await expect(badge).toHaveAttribute("data-tg-arg-badge", "confirmed");
    await shoot(page, "F9", "arg-undo-1440");
    await sidePanel(page).getByRole("button", { name: "復原" }).click();
    await expect(sidePanel(page).getByText(/已把 \d+ 則改回 AI 草稿。/)).toBeVisible();
    await expect(badge).toHaveAttribute("data-tg-arg-badge", "draft");
    await expect(card).toBeVisible();
  });

  test("S12 (B15): a relation of kind 矛盾 marks the other end's card 前提已更新", async ({ page }) => {
    await openNas(page);
    await openTab(page, "結構");
    // F19 §4: the outline lists no 關聯 section while the conversation has none; 建立關聯… is in the command palette.
    await expect(sidePanel(page).getByRole("button", { name: "新增關聯" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("option", { name: "建立關聯…" }).click();
    const dialog = page.getByRole("dialog", { name: "建立關聯" });
    await dialog.getByRole("combobox", { name: "連到" }).click();
    await page.getByRole("option", { name: new RegExp(ZFS.purpose) }).click();
    await dialog.getByRole("radio", { name: "矛盾" }).click();
    await expect(dialog).toContainText("前提已更新");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F9", "relation-kind-1440");
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog).toBeHidden();
    await expect(outlineRow(page, ZFS.purpose)).toHaveAccessibleName(/前提已更新/);
    const badge = page.getByRole("region", { name: "結論卡" }).getByRole("button", { name: /前提已更新$/ });
    await badge.click();
    await expect(page.getByRole("dialog", { name: "前提為什麼更新了" })).toContainText("和這張卡矛盾");
  });

  test("S12: replacing a note the card relied on marks it 前提已更新 (card and outline); 知道了 sets it aside", async ({ page }) => {
    await openNas(page);
    await openTab(page, "紀要");
    const decided = sidePanel(page).getByRole("region", { name: /^已決定/ });
    await decided.getByRole("listitem").filter({ hasText: "檔案系統用 ZFS mirror" }).hover();
    await decided.getByRole("listitem").filter({ hasText: "檔案系統用 ZFS mirror" }).getByRole("button", { name: "取代" }).click();
    await decided.getByRole("textbox", { name: "新的內容（舊的會劃掉保留）" }).fill("檔案系統改用 Btrfs RAID1");
    await decided.getByRole("button", { name: "儲存" }).click();
    const card = page.getByRole("region", { name: "結論卡" });
    const badge = card.getByRole("button", { name: /前提已更新$/ });
    await expect(badge).toBeVisible();
    await badge.click();
    const reasons = page.getByRole("dialog", { name: "前提為什麼更新了" });
    await expect(reasons).toContainText("依據的紀要「檔案系統用 ZFS mirror」已被取代為「檔案系統改用 Btrfs RAID1」。");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", "s12-stale-1440");
    await openTab(page, "結構");
    await expect(outlineRow(page, ZFS.purpose)).toHaveAccessibleName(/前提已更新/);
    await badge.click();
    await reasons.getByRole("button", { name: "知道了，這些不再提醒" }).click();
    await expect(badge).toHaveCount(0);
  });

  test("S10: 請 AI 檢驗理解… opens an investigate branch with the check in the composer, never sent", async ({ page }) => {
    await page.goto(`/?${Q}&line=${NAS}&focus=1`);
    await expect(page.locator(`[data-tg-map-node="${ZFS.id}"] > button`).first()).toBeVisible({ timeout: 30_000 });
    await page.locator(`[data-tg-map-node="${ZFS.id}"] > button`).first().click();
    const panel = page.getByRole("region", { name: "節點面板" });
    await panel.getByRole("radio", { name: /^備忘（不給 AI）/ }).click();
    const memos = panel.getByRole("region", { name: /^備忘（不給 AI）/ });
    await memos.getByRole("button", { name: "這則備忘的動作" }).click();
    await page.getByRole("menuitem", { name: "請 AI 檢驗理解…" }).click();
    const dialog = page.getByRole("dialog", { name: "開支線" });
    // F10: the check is the dialog's first question; 只開支線，稍後再問 leaves it in the composer, unsent.
    await expect(dialog.getByRole("textbox", { name: "第一句要問 AI 什麼" })).toHaveValue(/問一下小陳他家的 ZFS 跑了幾年/);
    await expect(dialog).toContainText(/目的檢驗理解：問一下小陳/);
    await expect(dialog).toContainText("已經結束，新支線會從它的分岔點");
    await dialog.getByRole("button", { name: "只開支線，稍後再問" }).click();
    await expect(dialog).toBeHidden();
    await expect(composer(page)).toHaveValue(/問一下小陳他家的 ZFS 跑了幾年/);
    await expect(page.getByText("已填進輸入框，還沒送出。備忘本來不給 AI；按送出後，這一輪才會帶著它。")).toBeVisible();
    await expect(page.locator("[data-tg-message]")).toHaveCount(0);
    await shoot(page, "F8", "s10-feynman-1440");
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the search bar and the message actions fit the frame", async ({ page }) => {
    await openNas(page, "frame=embed&lang=zh-TW");
    await composer(page).focus();
    await page.keyboard.press("Control+f");
    await page.getByRole("combobox", { name: "在對話內搜尋" }).fill("ZFS");
    await expect(page.getByRole("listbox", { name: "在對話內搜尋" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
    await expectAccessible(page);
    await shoot(page, "F8", "s3-search-420");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("a message's actions open as a bottom sheet with 44px rows; the search lives in the header's menu", async ({ page }) => {
    await openNas(page);
    const reply = replies(page).last();
    await expect(reply.getByRole("toolbar", { name: "訊息動作" })).toBeHidden();
    await reply.getByRole("button", { name: "更多動作" }).tap();
    const sheet = page.getByRole("dialog", { name: /的動作$/ });
    await expect(sheet).toBeVisible();
    const rows = sheet.getByRole("button");
    await expect(rows.first()).toBeVisible();
    for (const box of await rows.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F8", "s1-sheet-375");
    await sheet.getByRole("button", { name: "取消" }).tap();
    await expect(sheet).toBeHidden();
    await page.locator("main > header").getByRole("button", { name: /的動作$/ }).tap();
    await page.getByRole("menuitem", { name: /在對話內搜尋/ }).tap();
    const box = page.getByRole("combobox", { name: "在對話內搜尋" });
    await box.fill("ZFS");
    const results = page.getByRole("listbox", { name: "在對話內搜尋" });
    await results.getByRole("option").first().tap();
    await expect(results).toBeHidden();
    await expect(box).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });

  test("parking a list fills the screen", async ({ page }) => {
    await openNas(page);
    await turn(page, "[fake:list] 接下來要查什麼？");
    await messageAction(replies(page).last(), "將清單存入停車場（4 項）…", { tap: true });
    const dialog = page.getByRole("dialog", { name: "把清單存入停車場" });
    const box = await dialog.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(370);
    await expectAccessible(page);
    await shoot(page, "F8", "s11-seeds-375");
  });
});
