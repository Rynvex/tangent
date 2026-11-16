import { expect, test } from "@playwright/test";
import { nodeOf, pickFive, Q } from "./f14-flows";
import { expectAccessible, isApi, SERIOUS, shoot } from "./helpers";

/**
 * F14 (docs/prompts/F14.md, design 2026-11-02) on the mock: S1 several
 * exports at once, search and picks; S2 the sessions oldest first with the
 * peek; S3 the timeline (overlap warning), the tree (role menu, attach
 * point, card editor) and batch; S4 the summary bar, the import, the new
 * line's chapter strip with dates, the gap divider, the card in place, the
 * decompose panel's real-time cuts, the toast and 復原這次匯入; the phone's
 * 時間序｜結構圖 tabs and its banner instead of the panel.
 */

test.beforeEach(({}, info) => test.skip(isApi(info), "F14's flows run on the mock's scenario"));
test.use({ timezoneId: "Asia/Taipei" });

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("S1–S4: three exports, arranged by time, assembled as a tree and imported with its suggestions, then undone", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    const dialog = page.getByRole("dialog", { name: "匯入對話" });
    await pickFive(page, dialog);
    await expect(dialog.getByRole("button", { name: /檔案時間 08\/18/ })).toBeVisible();
    await expect(dialog.locator('[data-tg-session-row*="f14-load"]')).toContainText("首問符合：pgbench 200 連線時 p95 飆高");
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F14", "s1-pick-search-1440");

    // S2: oldest first; the peek of the first session, one stretch opened.
    await dialog.getByRole("button", { name: "下一步：時間序拼圖預覽" }).click();
    const titles = dialog.locator("[data-tg-session-node] h4");
    await expect(titles).toHaveText(["PG 連線池設定", "PgBouncer transaction mode 的限制", "高併發壓測與鎖等待", "壓測筆記", "最終設定檔"]);
    await dialog.getByRole("button", { name: /小展開・12 則・1 個時間斷點・1 個重問/ }).click();
    await expect(dialog.getByText("間隔 2 小時 37 分")).toBeVisible();
    await dialog.getByRole("button", { name: /#5–#12/ }).click();
    await expect(dialog.getByRole("button", { name: "移除 #6" })).toBeVisible();
    await shoot(page, "F14", "s2-order-mini-expand-1440");

    // S3 timeline: B started while A was going (decision #1); the tree is suggested, never chosen by itself.
    await expect(dialog.getByRole("radio", { name: /時間軸章節圖/ })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("偵測到時間穿插：「PgBouncer transaction mode 的限制」（08/12 15:10）發生在「PG 連線池設定」進行期間。")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /主幹＋支線樹/ })).toContainText("建議");
    await expect(dialog.getByText(/將建立 1 條主線（5 個章節，共 54 則訊息，跨度 08\/12–08\/20）/)).toBeVisible();
    await shoot(page, "F14", "s3-timeline-interleave-1440");

    // S3 tree: B hangs on §1 #4; 壓測筆記 becomes a branch on §2 #18 from its menu; B's card edited in place.
    await dialog.getByRole("button", { name: "改用樹狀圖" }).click();
    await expect(nodeOf(dialog, "PgBouncer transaction mode 的限制")).toContainText(/掛在 §1 #4（14:58） ?之後・時間穿插/);
    await nodeOf(dialog, "壓測筆記").getByRole("button", { name: "「壓測筆記」的角色" }).click();
    await page.getByRole("menuitemradio", { name: /掛為支線並留結論卡/ }).click();
    await expect(nodeOf(dialog, "壓測筆記")).toContainText(/掛在 §2 #18（11:40） ?之後・依檔案時間/);
    await nodeOf(dialog, "壓測筆記").getByRole("button", { name: "「壓測筆記」的角色" }).click();
    await expect(page.getByRole("menuitemradio", { name: /掛為支線並留結論卡/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("combobox", { name: "掛在" })).toBeVisible();
    await shoot(page, "F14", "s3-tree-role-menu-1440");
    await page.keyboard.press("Escape");
    const card = nodeOf(dialog, "PgBouncer transaction mode 的限制");
    await card.getByRole("button", { name: "改結論" }).click();
    const conclusion = card.getByRole("textbox", { name: "「PgBouncer transaction mode 的限制」的結論" });
    await conclusion.fill("");
    await expect(card.getByText("結論不能空白")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "確認並純匯入" })).toHaveAttribute("aria-disabled", "true");
    await conclusion.fill("不能用 session 層級的 SET；改在交易內用 SET LOCAL。");
    await expect(dialog.getByText(/將建立 1 條主線（3 個章節、2 條支線與結論卡，共 54 則訊息，跨度 08\/12–08\/20）・不呼叫模型/)).toBeVisible();
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F14", "s3-tree-card-editor-1440");

    // S3 batch: one box for the folder and tags, neighbours related.
    await dialog.getByRole("radio", { name: /批次獨立匯入/ }).click();
    await expect(dialog.getByText("將建立 5 條主線（4 條相鄰關聯，共 54 則訊息）・不呼叫模型")).toBeVisible();
    await expect(dialog.getByText("相關", { exact: true })).toHaveCount(4);
    await shoot(page, "F14", "s3-batch-1440");
    await dialog.getByRole("radio", { name: /主幹＋支線樹/ }).click();
    await dialog.getByRole("button", { name: "改資料夾與標籤" }).click();
    await dialog.getByRole("textbox", { name: "主線標題" }).fill("Postgres 連線池與高併發");
    await shoot(page, "F14", "s4-summary-bar-1440");

    // S4: import with the suggestions.
    await dialog.getByRole("button", { name: "確認結構並展開拆解建議" }).click();
    await expect(dialog).toBeHidden();
    const toast = page.getByText("已匯入：1 條主線、3 個章節、2 條支線與結論卡");
    await expect(toast).toBeVisible();
    const strip = page.getByRole("navigation", { name: "主線章節" });
    await expect(strip.getByRole("button", { name: "§1 PG 連線池設定 08/12" })).toBeVisible();
    // F14.1: the idle chapters the server cuts at long pauses (the mock cuts them too), their date shown once.
    await expect(strip.getByRole("button", { name: "§2 2026/08/12 17:35", exact: true })).toBeVisible();
    await expect(strip.getByRole("button", { name: "§5 最終設定檔 08/20" })).toBeVisible();
    await strip.getByRole("button", { name: "§1 PG 連線池設定 08/12" }).click();
    // The 2 h 37 min pause opens the idle chapter §2 (as on the server), whose divider stands where the gap divider was.
    const idle = page.locator('[data-tg-chapter="1"]');
    await idle.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(idle).toContainText("17:35");
    await expect(page.getByText("不能用 session 層級的 SET；改在交易內用 SET LOCAL。").first()).toBeVisible();
    const panel = page.getByRole("complementary", { name: "拆解與整理建議" });
    await expect(panel.getByText("依真實時間")).toBeVisible();
    await expect(panel.getByText(/間隔很久/).first()).toBeVisible();
    await shoot(page, "F14", "s4-imported-main-line-1440");

    // Decision #8: 復原這次匯入 (the toast's; the banner has one too, F14.1) deletes what the import made.
    await page.locator('[aria-live="polite"]').getByRole("button", { name: "復原這次匯入" }).click();
    await expect(page.getByText("已復原：這次匯入的 1 條主線已刪除")).toBeVisible();
    await shoot(page, "F14", "s4-undo-toast-1440");
    await expect(page.getByRole("navigation", { name: "對話", exact: true }).getByText("Postgres 連線池與高併發")).toHaveCount(0);
  });

  test("S2 decision #4: a time set on the file-dated session re-sorts the list", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    const dialog = page.getByRole("dialog", { name: "匯入對話" });
    await pickFive(page, dialog);
    await dialog.getByRole("button", { name: "下一步：時間序拼圖預覽" }).click();
    const node = dialog.locator("[data-tg-session-node]").filter({ hasText: "壓測筆記" });
    await node.getByRole("button", { name: /檔案時間 08\/18/ }).click();
    const popup = page.getByRole("dialog", { name: "設定「壓測筆記」的時間" });
    await expect(popup).toContainText("目前用的是檔案修改時間 08/18。");
    await popup.getByLabel("日期").fill("2026-08-13");
    await popup.getByLabel("時間").fill("20:30");
    await popup.getByRole("button", { name: "套用" }).click();
    await expect(dialog.locator("[data-tg-session-node] h4")).toHaveText(["PG 連線池設定", "PgBouncer transaction mode 的限制", "壓測筆記", "高併發壓測與鎖等待", "最終設定檔"]);
    // Alt+Down on the handle moves it back.
    await node.getByRole("button", { name: /調整「壓測筆記」的順序/ }).press("Alt+ArrowDown");
    await expect(dialog.locator("[data-tg-session-node] h4").nth(3)).toHaveText("壓測筆記");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("full screen, 時間序｜結構圖 tabs, and the banner instead of the panel after importing", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "匯入對話" }).tap();
    const dialog = page.getByRole("dialog", { name: "匯入對話" });
    await pickFive(page, dialog, true);
    await shoot(page, "F14", "s1-pick-375");
    await dialog.getByRole("button", { name: "下一步：排序與結構" }).tap();
    const tabs = dialog.getByRole("tablist", { name: "排序與結構" });
    await expect(tabs.getByRole("tab", { name: /時間序 5/ })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.locator("[data-tg-session-node]")).toHaveCount(5);
    await shoot(page, "F14", "s2-tabs-time-375");
    await tabs.getByRole("tab", { name: /結構圖/ }).tap();
    await expect(dialog.getByRole("radiogroup", { name: "組裝方式" })).toBeVisible();
    await dialog.getByRole("radio", { name: /主幹＋支線樹/ }).tap();
    await expect(nodeOf(dialog, "PgBouncer transaction mode 的限制")).toContainText("主線留下的結論卡");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "F14", "s3-tabs-structure-375");
    await dialog.getByRole("button", { name: "確認結構並展開拆解建議" }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/已匯入 54 則・\d+ 項拆解建議/)).toBeVisible();
    await expect(page.getByRole("button", { name: "查看", exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "拆解與整理建議" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "F14", "s4-banner-375");
  });
});
