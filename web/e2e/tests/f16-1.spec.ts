import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longCombinedExport } from "../../packages/client/src/import-combined-fixtures";
import { Q } from "./f14-flows";
import { expectAccessible, isApi, SERIOUS, shoot } from "./helpers";

/**
 * F16.1 (docs/prompts/F16_1.md) on the mock: step 2 with many topics cut from
 * one combined export: the compact view, the filter row, Shift ranges with
 * the mouse and the keyboard, the batch bar, merging two and splitting them
 * back, and HTML5 drags onto the role zones and a chapter; on a phone the
 * compact list and the batch bar without handles or drop zones.
 */

test.beforeEach(({}, info) => test.skip(isApi(info), "F16.1 runs on the mock's scenario"));
test.use({ timezoneId: "Asia/Taipei" });

const TOPICS = ["Docker 容器是什麼?", "Kubernetes 叢集是什麼?", "PostgreSQL 索引是什麼?", "Redis 快取是什麼?", "Nginx 反向代理是什麼?", "Rust 所有權是什麼?"];

/** Twelve topics of three rounds in one combined export. */
function combinedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tangent-f16-1-"));
  const path = join(dir, "Gemini-Combined_雜談-2026-11-03.json");
  writeFileSync(path, JSON.stringify(longCombinedExport(12, 3)));
  return path;
}

const cardOf = (dialog: Locator, title: string) => dialog.locator("[data-tg-session-node]").filter({ has: dialog.page().locator("h4", { hasText: title }) });
const boxOf = (dialog: Locator, title: string) => dialog.getByRole("checkbox", { name: `選取「${title}」（Shift 可連選）` });
const pillOf = (dialog: Locator, title: string) => cardOf(dialog, title).locator("[data-tg-role-trigger]");

/** An HTML5 drag whose target appears only once the drag has started (a chapter's 掛在 / 合併進). */
async function dragOnto(page: Page, source: Locator, target: Locator) {
  await source.hover();
  await page.mouse.down();
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 });
  await target.hover();
  await page.mouse.up();
}

async function openStep2(page: Page, tap = false) {
  const dialog = page.getByRole("dialog", { name: "匯入對話" });
  await page.locator('input[type="file"]').setInputFiles(combinedFile());
  await expect(dialog.getByText("Gemini・12 篇", { exact: true })).toBeVisible();
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  await press(dialog.getByRole("button", { name: tap ? "全選" : "全選符合的" }));
  await press(dialog.getByRole("button", { name: tap ? "下一步：排序與結構" : "下一步：時間序拼圖預覽" }));
  return dialog;
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("compact rows, a Shift range, the batch bar, merge and split, and drags onto the zones and a chapter", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    const dialog = await openStep2(page);
    const cards = dialog.locator("[data-tg-session-node]");
    await expect(cards).toHaveCount(12);
    await expect(dialog.locator("[data-tg-compact-toggle]")).toHaveText("詳細卡片");
    const row = await cards.first().boundingBox();
    expect(row!.height).toBeLessThanOrEqual(40);
    await shoot(page, "F16.1", "step2-compact-1440");

    // The filter row narrows the list; clearing it brings every one back.
    const search = dialog.getByRole("searchbox", { name: "篩選對話（標題與首問）" });
    await search.fill("Redis");
    await expect(cards).toHaveCount(1);
    await search.fill("");
    await expect(cards).toHaveCount(12);

    // A click, Shift+click with the mouse, then Shift+Space from the keyboard.
    await boxOf(dialog, TOPICS[0]!).click();
    await boxOf(dialog, TOPICS[3]!).click({ modifiers: ["Shift"] });
    const bar = dialog.locator("[data-tg-batch-bar]");
    await expect(bar).toContainText("已選 4 篇");
    await boxOf(dialog, TOPICS[5]!).focus();
    await page.keyboard.press("Shift+Space");
    await expect(bar).toContainText("已選 6 篇");
    await expect(dialog.locator('[data-tg-blueprint-node] [data-tg-drop-attach]').first()).toBeVisible();
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F16.1", "step2-batch-bar-1440");
    await bar.getByRole("button", { name: "另存成獨立對話" }).click();
    for (const title of TOPICS) await expect(pillOf(dialog, title)).toHaveText("獨立對話");
    await bar.getByRole("button", { name: "取消選取" }).click();
    await expect(bar).toHaveCount(0);

    // Merge two into one, then split them back from the menu.
    await boxOf(dialog, TOPICS[1]!).click();
    await boxOf(dialog, TOPICS[2]!).click();
    await bar.getByRole("button", { name: "合併成 1 篇" }).click();
    await expect(cards).toHaveCount(11);
    await expect(cardOf(dialog, TOPICS[1]!)).toContainText("已合併 2 篇");
    await expect(dialog.getByText(`已把 2 篇合併成「${TOPICS[1]}」。`)).toBeVisible();
    await shoot(page, "F16.1", "step2-merged-1440");
    await cardOf(dialog, TOPICS[1]!).getByRole("button", { name: `「${TOPICS[1]}」的角色`, exact: false }).click();
    await page.getByRole("button", { name: "拆回原本的 2 篇" }).click();
    await expect(cards).toHaveCount(12);
    await expect(cards.locator("h4").nth(2)).toHaveText(TOPICS[2]!);

    // HTML5 drags onto the 獨立對話 zone, then in the tree onto the chapter zone and §1's 掛在 target.
    const handle = (title: string) => cardOf(dialog, title).locator("[data-tg-handle]");
    await handle(TOPICS[1]!).dragTo(dialog.locator('[data-tg-drop-role="standalone"]'));
    await expect(pillOf(dialog, TOPICS[1]!)).toHaveText("獨立對話");
    await dialog.getByRole("radio", { name: /主幹＋支線樹/ }).click();
    // Every one of the first six is separate now: the chapter zone makes the first one §1 again.
    await handle(TOPICS[0]!).dragTo(dialog.locator('[data-tg-drop-role="chapter"]'));
    await expect(pillOf(dialog, TOPICS[0]!)).toHaveText("§1");
    await dragOnto(page, handle(TOPICS[2]!), dialog.locator("[data-tg-drop-attach]").first());
    await expect(pillOf(dialog, TOPICS[2]!)).toHaveText("↳ 支線");
    await expect(dialog.getByText(/已把 1 篇掛在 §1 下。/)).toBeVisible();
    await shoot(page, "F16.1", "step2-tree-after-drops-1440");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("the compact list and the batch bar, without handles or drop zones", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "匯入對話" }).tap();
    const dialog = await openStep2(page, true);
    await expect(dialog.locator("[data-tg-session-node]")).toHaveCount(12);
    await expect(dialog.locator("[data-tg-handle]")).toHaveCount(0);
    await expect(dialog.locator("[data-tg-drop-zones]")).toHaveCount(0);
    await shoot(page, "F16.1", "step2-compact-375");
    await boxOf(dialog, TOPICS[0]!).tap();
    await boxOf(dialog, TOPICS[1]!).tap();
    const bar = dialog.locator("[data-tg-batch-bar]");
    await expect(bar).toContainText("已選 2 篇");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Every action and the chapter select lie fully inside the bar (they wrap; nothing hides off to the side).
    const outer = (await bar.boundingBox())!;
    const controls = bar.locator("button, select");
    expect(await controls.count()).toBeGreaterThanOrEqual(5);
    for (const control of await controls.all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(outer.x);
      expect(box.y).toBeGreaterThanOrEqual(outer.y);
      expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width);
      expect(box.y + box.height).toBeLessThanOrEqual(outer.y + outer.height);
    }
    await shoot(page, "F16.1", "step2-batch-bar-375");
    await dialog.locator("[data-tg-batch-bar]").getByRole("button", { name: "合併成 1 篇" }).tap();
    await expect(dialog.locator("[data-tg-session-node]")).toHaveCount(11);
    await expect(dialog.locator("[data-tg-drop-attach]")).toHaveCount(0);
  });
});
