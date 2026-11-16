import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { replies } from "./flows";
import { expectAccessible, isApi, MODERATE, messageAction, shoot, SERIOUS } from "./helpers";

/**
 * F13 (16_FRONTEND_F13.md, design 2026-10-30) on the mock: S1 the list's
 * folders and #tag filter, S2 importing a ChatGPT export (with its edited
 * question and regenerated reply), S4 the decompose panel (fold, chapters,
 * tags, parking, extract with a card), S3 從這則抽成支線… from a message,
 * S5 the conversation menu and the folder-and-tags popover — at 1440 and 375.
 */

const Q = "theme=light&lang=zh-TW";
const FIXTURE = fileURLToPath(new URL("../fixtures/chatgpt-conversations.json", import.meta.url));
const TITLE = "Postgres MVCC 與索引設計";
const said = (page: Page, text: string) => page.locator("li[data-message-id]").filter({ hasText: text });
/** F14: one conversation of the file is checked and goes through F13's form with 快速匯入單篇. */
async function quickSingle(dialog: Locator, title: string, { tap = false }: { tap?: boolean } = {}) {
  const box = dialog.getByRole("checkbox", { name: title, exact: true });
  await (tap ? box.tap() : box.click());
  const quick = dialog.getByRole("button", { name: "快速匯入單篇" });
  await (tap ? quick.tap() : quick.click());
}

test.beforeEach(({}, info) => test.skip(isApi(info), "F13's flows run on the mock's scenario"));

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("S1: folders above the time groups, one #tag at a time with its banner, the folder menu", async ({ page }) => {
    await page.goto(`/?${Q}`);
    const list = page.getByRole("navigation", { name: "對話", exact: true });
    const folder = list.getByRole("region", { name: "家用設備" });
    await expect(folder).toContainText("家用 NAS 與備份策略");
    await expect(list.getByRole("region", { name: "旅行" })).toContainText("日本行程");
    const chips = list.getByRole("radiogroup", { name: "依標籤篩選" });
    await expect(chips.getByRole("radio", { name: "全部" })).toHaveAttribute("aria-checked", "true");
    await chips.getByRole("radio", { name: /^#nas/ }).click();
    await expect(list.getByText("篩選標籤：#nas（1 篇）")).toBeVisible();
    await expect(list.getByText("學習 Rust 的所有權與借用")).toBeHidden();
    // Folders without a match are hidden while filtering.
    await expect(list.getByRole("region", { name: "旅行" })).toHaveCount(0);
    await expectAccessible(page, SERIOUS, 'nav[aria-label="對話"]');
    await shoot(page, "F13", "filter-1440");
    await list.getByRole("button", { name: "清除" }).click();
    await expect(list.getByText("學習 Rust 的所有權與借用")).toBeVisible();
    await folder.getByRole("button", { name: /^家用設備/ }).hover();
    await list.getByRole("button", { name: "資料夾「家用設備」的動作" }).click();
    await expect(page.getByRole("menuitem", { name: /重新命名資料夾/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /解散資料夾/ })).toContainText("對話移回未分類，不會刪除");
    await shoot(page, "F13", "folders-menu-1440");
    await page.getByRole("menuitem", { name: /重新命名資料夾/ }).click();
    const field = list.getByRole("textbox", { name: "「家用設備」的新名稱" });
    await field.fill("Home lab");
    await field.press("Enter");
    await expect(list.getByRole("region", { name: "Home lab" })).toContainText("家用 NAS 與備份策略");
  });

  test("S2 + S4 + S3: import an export, then fold, cut chapters, tag, park and extract from the suggestions", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await expect(replies(page).first()).toBeVisible();
    // An older conversation of the same file first: a related one for the panel's ④.
    await page.getByRole("button", { name: "匯入對話" }).click();
    let dialog = page.getByRole("dialog", { name: "匯入對話" });
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await quickSingle(dialog, "Postgres Autovacuum 調校筆記");
    await dialog.getByRole("combobox", { name: "放入資料夾" }).click();
    await page.getByRole("option", { name: "新資料夾…" }).click();
    await dialog.getByRole("textbox", { name: "新資料夾名稱" }).fill("資料庫與儲存");
    await dialog.getByRole("button", { name: "純匯入" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("已匯入 4 則訊息・沒有找到拆解建議").or(page.getByText(/已匯入 4 則訊息/))).toBeVisible();

    await page.getByRole("button", { name: "匯入對話" }).click();
    dialog = page.getByRole("dialog", { name: "匯入對話" });
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await expect(dialog.getByText("ChatGPT・2 篇", { exact: true })).toBeVisible();
    await quickSingle(dialog, TITLE);
    await expect(dialog.getByRole("checkbox", { name: /把 2 個重問／重新生成還原成「另一條路」支線/ })).toBeChecked();
    await expect(dialog.getByText("18 則・2 條支線・不呼叫模型")).toBeVisible();
    await dialog.getByRole("combobox", { name: "放入資料夾" }).click();
    await page.getByRole("option", { name: "資料庫與儲存" }).click();
    await dialog.getByRole("textbox", { name: "標籤" }).fill("postgres");
    await dialog.getByRole("textbox", { name: "標籤" }).press("Enter");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F13", "import-1440");
    await dialog.getByRole("button", { name: "匯入並開啟拆解建議" }).click();
    await expect(dialog).toBeHidden();

    // S4: the banner and the panel standing in for the side panel.
    const panel = page.getByRole("complementary", { name: "拆解與整理建議" });
    await expect(panel).toBeVisible();
    await expect(page.getByText(/已匯入 18 則訊息・有 \d+ 項拆解與支線建議/)).toBeVisible();
    await expect(page.getByRole("button", { name: "已打開建議" })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByText(/#7～#10（4 則）偏離主線/)).toBeVisible();
    await panel.getByText(/#7～#10（4 則）偏離主線/).hover();
    await expect(page.locator("style[data-tg-range-highlight]")).toHaveCount(1);
    await expectAccessible(page, MODERATE, 'aside[aria-label="拆解與整理建議"]');
    await shoot(page, "F13", "decompose-1440");
    await panel.getByRole("button", { name: "一鍵建立 2 個章節切點" }).click();
    await expect(panel.getByRole("button", { name: "復原" }).first()).toBeVisible();
    await panel.getByRole("button", { name: "加上標籤 #mvcc" }).click();
    await expect(panel.getByRole("button", { name: "已加上標籤 #mvcc" })).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "存入停車場（3 項）" }).click();
    await expect(panel.getByText("已存入停車場（3 項）")).toBeVisible();
    await expect(panel.getByText("Postgres Autovacuum 調校筆記")).toBeVisible();

    // ① → S3 prefilled from the detour; a card stays where #7–#10 were.
    await panel.getByRole("button", { name: "抽成支線並留結論卡" }).click();
    const extract = page.getByRole("dialog", { name: "從 #7 抽成支線" });
    await expect(extract.getByRole("combobox", { name: "到" })).toContainText("#10 AI");
    await expect(extract.getByRole("textbox", { name: /結論/ })).toHaveValue(/host\.docker\.internal/);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F13", "extract-from-panel-1440");
    await extract.getByRole("button", { name: "抽成支線並留結論卡" }).click();
    await expect(extract).toBeHidden();
    await expect(panel.getByText("已抽成支線")).toBeVisible();
    // The question is gone from the main line; only the card (which quotes it) is left.
    await expect(said(page, "為什麼容器連不上宿主機的 Postgres").filter({ hasNotText: "看支線" })).toHaveCount(0);
    // The card sits in the range's place: after #6's reply, before 回到正題.
    const ids = await page.locator("li[data-message-id]").evaluateAll((items) => items.map((item) => item.textContent ?? ""));
    const card = ids.findIndex((text) => text.includes("host.docker.internal") && text.includes("看支線"));
    const back = ids.findIndex((text) => text.includes("回到正題"));
    const before = ids.findIndex((text) => text.includes("索引先建在"));
    expect(before).toBeGreaterThanOrEqual(0);
    expect(card).toBeGreaterThan(before);
    expect(back).toBeGreaterThan(card);
    await panel.getByRole("button", { name: "關閉建議" }).click();
    await expect(panel).toBeHidden();

    // S3 from a message: the menu item, the range outlined, a reply's start moves up to its question.
    const reply = said(page, "看 pg_stat_user_tables");
    await messageAction(reply, "從這則抽成支線…");
    const fromReply = page.getByRole("dialog", { name: /^從 #\d+ 抽成支線$/ });
    await expect(fromReply.getByText(/從 AI 回覆打開，起點對齊到這一輪的提問/)).toBeVisible();
    await expect(page.locator("style[data-tg-range-highlight]")).toHaveCount(1);
    await shoot(page, "F13", "extract-dialog-1440");
    await fromReply.getByRole("button", { name: "取消" }).click();
    await expect(page.locator("style[data-tg-range-highlight]")).toHaveCount(0);
  });

  test("B18.1: a big export (over 1 MB) is parsed in a worker and reads the same as a small one", async ({ page }) => {
    // The fixture's two conversations plus padding conversations (their own ids) up to well over the worker's 1 MiB.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Array<Record<string, unknown>>;
    const filler = fixture[0]!;
    const padded = [...fixture];
    for (let i = 0; JSON.stringify(padded).length < 1_300_000; i += 1) padded.push({ ...filler, title: `Padding ${i}`, conversation_id: `padding-${i}`, update_time: 1 });
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    const dialog = page.getByRole("dialog", { name: "匯入對話" });
    const worker = page.waitForEvent("worker", { predicate: (started) => started.url().includes("import-worker") });
    await page.locator('input[type="file"]').setInputFiles({ name: "conversations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(padded)) });
    await worker;
    await expect(dialog.getByText(/^ChatGPT・\d+ 篇$/)).toBeVisible();
    // The same conversation, with its restorable versions, as from the small file.
    await quickSingle(dialog, TITLE);
    await expect(dialog.getByText("18 則・2 條支線・不呼叫模型")).toBeVisible();
  });

  test("S3: the first turn cannot be moved (nothing before it to hang a branch on)", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    const importing = page.getByRole("dialog", { name: "匯入對話" });
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await quickSingle(importing, TITLE);
    await importing.getByRole("button", { name: "純匯入" }).click();
    await expect(importing).toBeHidden();
    await messageAction(said(page, "幫我設計一個多租戶 SaaS 的事件表"), "從這則抽成支線…");
    const dialog = page.getByRole("dialog", { name: /抽成支線$/ });
    await expect(dialog.getByRole("alert")).toContainText("這是第一輪對話");
    await expect(dialog.getByRole("button", { name: "抽成支線並留結論卡" })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: "取消" }).click();
  });

  test("S5: the conversation menu's two new items and the folder-and-tags popover save as they change", async ({ page }) => {
    await page.goto(`/?${Q}`);
    const list = page.getByRole("navigation", { name: "對話", exact: true });
    const rust = list.locator("[data-tg-list-row]").filter({ hasText: "學習 Rust 的所有權與借用" });
    await rust.hover();
    await rust.getByRole("button", { name: "「學習 Rust 的所有權與借用」的動作" }).click();
    await expect(page.getByRole("menuitem", { name: /資料夾與標籤…/ })).toContainText("新");
    await expect(page.getByRole("menuitem", { name: /拆解與整理建議…/ })).toBeVisible();
    await shoot(page, "F13", "conversation-menu-1440");
    await page.getByRole("menuitem", { name: /資料夾與標籤…/ }).click();
    const pop = page.getByRole("dialog", { name: "資料夾與標籤" });
    await expect(pop).toBeVisible();
    await pop.getByRole("button", { name: "旅行", exact: true }).click();
    await pop.getByRole("textbox", { name: "標籤" }).fill("borrow");
    await pop.getByRole("textbox", { name: "標籤" }).press("Enter");
    await expect(pop.getByText("2 / 12")).toBeVisible();
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F13", "folder-tags-1440");
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(list.getByRole("region", { name: "旅行" })).toContainText("學習 Rust 的所有權與借用");
    // Used once, the item is no longer marked new.
    await rust.hover();
    await rust.getByRole("button", { name: "「學習 Rust 的所有權與借用」的動作" }).click();
    await expect(page.getByRole("menuitem", { name: /資料夾與標籤…/ })).not.toContainText("新");
    await page.keyboard.press("Escape");
  });

  test("a viewer sees no import entry and no folder menu", async ({ page }) => {
    await page.goto(`/?${Q}&as=viewer`);
    const list = page.getByRole("navigation", { name: "對話", exact: true });
    await expect(list.getByRole("region", { name: "家用設備" })).toBeVisible();
    await expect(list.getByRole("button", { name: "匯入對話" })).toHaveCount(0);
    await expect(list.getByRole("button", { name: /資料夾「家用設備」的動作/ })).toHaveCount(0);
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("S1, S2, S4 and S5 fit the phone: the list drawer, the full-screen import, the tall panel, the bottom sheet", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    const list = page.getByRole("navigation", { name: "對話", exact: true });
    await expect(list.getByRole("region", { name: "家用設備" })).toBeVisible();
    await expect(list.getByRole("button", { name: "資料夾「家用設備」的動作" })).toBeVisible();
    await shoot(page, "F13", "list-375");
    await list.getByRole("button", { name: "匯入對話" }).tap();
    const dialog = page.getByRole("dialog", { name: "匯入對話" });
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);
    await quickSingle(dialog, TITLE, { tap: true });
    await expect(dialog.getByText("18 則・2 條支線・不呼叫模型")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "F13", "import-375");
    await dialog.getByRole("button", { name: "匯入並開啟拆解建議" }).tap();
    const panel = page.getByRole("complementary", { name: "拆解與整理建議" });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box?.y).toBeGreaterThanOrEqual(95);
    await shoot(page, "F13", "decompose-375");
    await panel.getByRole("button", { name: "關閉建議" }).tap();

    // S3 on the phone: the action sheet's item opens the full-screen dialog.
    await messageAction(said(page, "要怎麼監控膨脹"), "從這則抽成支線…", { tap: true });
    const extract = page.getByRole("dialog", { name: /抽成支線$/ });
    await expect(extract).toBeVisible();
    await shoot(page, "F13", "extract-375");
    await extract.getByRole("button", { name: "取消" }).tap();

    await page.getByRole("button", { name: "展開對話清單" }).tap();
    const imported = list.locator("[data-tg-list-row]").filter({ hasText: TITLE }).first();
    await imported.getByRole("button", { name: `「${TITLE}」的動作` }).tap();
    await page.getByRole("menuitem", { name: /資料夾與標籤…/ }).tap();
    const sheet = page.getByRole("dialog", { name: "資料夾與標籤" });
    await expect(sheet).toBeVisible();
    await shoot(page, "F13", "folder-tags-375");
  });
});
