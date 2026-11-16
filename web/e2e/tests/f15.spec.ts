import { expect, test, type Locator, type Page } from "@playwright/test";
import { nodeOf, pickFive, Q } from "./f14-flows";
import { expectAccessible, isApi, SERIOUS, shoot } from "./helpers";

/**
 * B20 + F14.1 + F15 (docs/prompts/B20.md §4.2) on the mock: after an
 * assembled import, the chapter strip shows an idle chapter's date once,
 * each message its time and an imported card 「匯入時建立」; the banner keeps
 * 復原這次匯入 after the toast went; and from the decompose panel's ④ another
 * conversation is attached as a branch with its card (POST /lines/{id}/attach).
 */

test.beforeEach(({}, info) => test.skip(isApi(info), "the flows run on the mock's scenario"));
test.use({ timezoneId: "Asia/Taipei" });

const banner = (page: Page) => page.locator("[data-tg-imported-banner]");
const undoInToast = (page: Page) => page.locator('[aria-live="polite"]').getByRole("button", { name: "復原這次匯入" });

/** The tree assembly of the five conversations, imported with its suggestions (under `title` when given). */
async function importTree(page: Page, dialog: Locator, title?: string) {
  await pickFive(page, dialog);
  await dialog.getByRole("button", { name: "下一步：時間序拼圖預覽" }).click();
  await dialog.getByRole("button", { name: "改用樹狀圖" }).click();
  await expect(nodeOf(dialog, "PgBouncer transaction mode 的限制")).toContainText(/掛在 §1 #4/);
  if (title) {
    await dialog.getByRole("button", { name: "改資料夾與標籤" }).click();
    await dialog.getByRole("textbox", { name: "主線標題" }).fill(title);
  }
  await dialog.getByRole("button", { name: "確認結構並展開拆解建議" }).click();
  await expect(dialog).toBeHidden();
}

/** The batch import of the five, all in a new folder (so each is related to the others), with the decompose panel. */
async function importBatch(page: Page, dialog: Locator, folder: string, tap = false) {
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  await pickFive(page, dialog, tap);
  await press(dialog.getByRole("button", { name: tap ? "下一步：排序與結構" : "下一步：時間序拼圖預覽" }));
  if (tap) await press(dialog.getByRole("tablist", { name: "排序與結構" }).getByRole("tab", { name: /結構圖/ }));
  await press(dialog.getByRole("radio", { name: /批次獨立匯入/ }));
  await press(dialog.getByRole("button", { name: "改資料夾與標籤" }));
  await press(dialog.getByRole("combobox", { name: "放入資料夾" }));
  await press(page.getByRole("option", { name: "新資料夾…" }));
  await dialog.getByRole("textbox", { name: "新資料夾名稱" }).fill(folder);
  await press(dialog.getByRole("button", { name: "確認結構並展開拆解建議" }));
  await expect(dialog).toBeHidden();
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("F14.1: idle chapters show their date once, messages their time, an imported card 匯入時建立, and the banner undoes after the toast went", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    await importTree(page, page.getByRole("dialog", { name: "匯入對話" }));
    const strip = page.getByRole("navigation", { name: "主線章節" });
    const idle = strip.getByRole("button", { name: "§2 2026/08/12 17:35", exact: true });
    await expect(idle).toBeVisible();
    await expect(idle).toHaveText("§22026/08/12 17:35");
    for (const name of await strip.getByRole("button").allTextContents()) expect(name.match(/\d\d\/\d\d/g)?.length ?? 0).toBeLessThanOrEqual(1);
    await expect(strip.getByRole("button", { name: "§1 PG 連線池設定 08/12" })).toBeVisible();
    // S4b: each message's time after its label; the import's conclusion card says it came from the import.
    await expect(page.locator("[data-tg-message-time]").first()).toHaveText("・08/12 14:20");
    const card = page.getByRole("region", { name: "結論卡" }).first();
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('[data-tg-card-state="imported"]')).toHaveText(/^匯入時建立・08\/12 \d\d:\d\d$/);
    await expectAccessible(page, SERIOUS);
    await shoot(page, "B20", "f14-1-chapters-times-card-1440");

    // The banner keeps 復原這次匯入 after the 15-second toast has gone.
    const bar = banner(page);
    await expect(bar.getByRole("button", { name: "復原這次匯入" })).toBeVisible();
    await expect(undoInToast(page)).toBeHidden({ timeout: 20_000 });
    await shoot(page, "B20", "f14-1-banner-undo-1440");
    await bar.getByRole("button", { name: "復原這次匯入" }).click();
    await expect(page.getByText("已復原：這次匯入的 1 條主線已刪除")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "對話", exact: true }).getByText("PG 連線池設定")).toHaveCount(0);
  });

  test("F15: 併為支線… attaches a related conversation with its card; the main line shows the card and the outline the branch", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    await importBatch(page, page.getByRole("dialog", { name: "匯入對話" }), "F15 連線池");
    const panel = page.getByRole("complementary", { name: "拆解與整理建議" });
    const related = panel.getByRole("region", { name: "相關對話與拆分" });
    const row = related.locator("[data-tg-related]").filter({ hasText: "PgBouncer transaction mode 的限制" });
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole("button", { name: "併為支線…" })).toBeVisible();
    await expect(related.getByRole("button", { name: "併入其他既有對話…" })).toBeVisible();
    await shoot(page, "B20", "f15-related-card-1440");

    await row.getByRole("button", { name: "併為支線…" }).click();
    const dialog = page.getByRole("dialog", { name: "併為此對話的支線" });
    await expect(dialog.getByText("PgBouncer transaction mode 的限制")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /掛為支線並留結論卡（已帶回）/ })).toBeChecked();
    await dialog.getByRole("textbox", { name: /結論/ }).fill("transaction mode 不能用 session 層級的 SET，改用 SET LOCAL。");
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "B20", "f15-attach-dialog-1440");
    await dialog.getByRole("button", { name: "併為支線" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText("已併為支線")).toBeVisible();
    await expect(row.getByRole("button", { name: "前往支線" })).toBeVisible();
    // The main line ends with the card.
    const card = page.getByRole("region", { name: "結論卡" }).last();
    await expect(card).toContainText("transaction mode 不能用 session 層級的 SET，改用 SET LOCAL。");
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "B20", "f15-attached-card-1440");
    // The outline shows the branch; the conversation left the list.
    await panel.getByRole("button", { name: "關閉建議" }).click();
    await expect(page.getByRole("tree", { name: "支線大綱" }).getByRole("treeitem", { name: /^PgBouncer transaction mode 的限制/ })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "對話", exact: true }).getByText("PgBouncer transaction mode 的限制")).toHaveCount(0);
    await shoot(page, "B20", "f15-outline-1440");
  });

  test("F15: 併入其他既有對話… picks any loaded conversation and attaches it as an open branch", async ({ page }) => {
    await page.goto(`/?${Q}`);
    // Five conversations of their own in a folder, then a tree that is related to none of them.
    await page.getByRole("button", { name: "匯入對話" }).click();
    await importBatch(page, page.getByRole("dialog", { name: "匯入對話" }), "F15 挑選");
    await page.getByRole("button", { name: "匯入對話" }).click();
    await importTree(page, page.getByRole("dialog", { name: "匯入對話" }), "F15 組裝");
    const related = page.getByRole("complementary", { name: "拆解與整理建議" }).getByRole("region", { name: "相關對話與拆分" });
    await related.getByRole("button", { name: "併入其他既有對話…" }).click();
    const dialog = page.getByRole("dialog", { name: "併為此對話的支線" });
    await dialog.getByRole("combobox", { name: "要併入的對話" }).click();
    await page.getByRole("option", { name: "最終設定檔" }).click();
    await dialog.getByRole("radio", { name: /掛為進行中支線/ }).click();
    await shoot(page, "B20", "f15-attach-picker-1440");
    await dialog.getByRole("button", { name: "併為支線" }).click();
    await expect(related.getByText("已把「最終設定檔」併為支線")).toBeVisible();
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("the banner's 復原這次匯入 and the attach dialog fit a phone", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "匯入對話" }).tap();
    await importBatch(page, page.getByRole("dialog", { name: "匯入對話" }), "F15 手機", true);
    const bar = banner(page);
    await expect(bar.getByRole("button", { name: "復原這次匯入" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "B20", "f14-1-banner-undo-375");
    await bar.getByRole("button", { name: "查看", exact: true }).tap();
    const related = page.getByRole("complementary", { name: "拆解與整理建議" }).getByRole("region", { name: "相關對話與拆分" });
    const row = related.locator("[data-tg-related]").first();
    await row.scrollIntoViewIfNeeded();
    await row.getByRole("button", { name: "併為支線…" }).tap();
    const dialog = page.getByRole("dialog", { name: "併為此對話的支線" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "B20", "f15-attach-dialog-375");
  });
});
