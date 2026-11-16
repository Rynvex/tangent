import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERLEAVED_ROUNDS, interleavedConversation } from "../../packages/client/src/import-combined-fixtures";
import { Q } from "./f14-flows";
import { expectAccessible, isApi, SERIOUS, shoot } from "./helpers";

/**
 * F16.2 (docs/prompts/B22.md) on the mock: one conversation of six rounds,
 * A → B → A → C → A → B, analyzed into a tree (the mock runs the server's
 * heuristic, no model): A's three rounds threaded into §1, B and C hung on
 * it with cards; one round moved out and back from the node's rounds menu;
 * undoing the analysis; on a phone the same without any horizontal overflow
 * and with every control inside its node.
 */

test.beforeEach(({}, info) => test.skip(isApi(info), "F16.2 runs on the mock's scenario"));
test.use({ timezoneId: "Asia/Taipei" });

const [A, B, , C, A3] = INTERLEAVED_ROUNDS.map(([question]) => question);

function conversationFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "tangent-f16-2-"));
  const path = join(dir, "電腦雜談.json");
  writeFileSync(path, JSON.stringify(interleavedConversation()));
  return path;
}

const nodeOf = (dialog: Locator, title: string) => dialog.locator("[data-tg-blueprint-node]").filter({ has: dialog.page().locator("p > span", { hasText: title }) });

async function openStep2(page: Page, tap = false) {
  const dialog = page.getByRole("dialog", { name: "匯入對話" });
  await page.locator('input[type="file"]').setInputFiles(conversationFile());
  const box = dialog.getByRole("checkbox", { name: "電腦雜談" });
  await expect(box).toHaveAttribute("aria-checked", "true");
  const next = dialog.getByRole("button", { name: tap ? "下一步：排序與結構" : "下一步：時間序拼圖預覽" });
  await (tap ? next.tap() : next.click());
  return dialog;
}

/** Every button and select of `scope` lies inside `outer` (nothing pushed off to the side). */
async function expectInside(scope: Locator, outer: Locator) {
  const frame = (await outer.boundingBox())!;
  for (const control of await scope.locator("button, select").all()) {
    if (!(await control.isVisible())) continue;
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(frame.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
  }
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("analyzes the rounds into §1 with two branches, moves one round out and back, and undoes it", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "匯入對話" }).click();
    const dialog = await openStep2(page);
    const bar = dialog.locator("[data-tg-ai-tree-bar]");
    await expect(bar.getByRole("checkbox", { name: /拆解對話內部的穿插問答輪次/ })).toBeChecked();
    await expect(bar).toContainText("共 6 輪");
    await shoot(page, "F16.2", "step2-ai-bar-1440");

    await bar.locator("[data-tg-ai-analyze]").click();
    const summary = dialog.locator("[data-tg-ai-summary]");
    await expect(summary).toContainText("1 個主幹章節、2 條支線、0 篇獨立對話");
    await expect(summary).toContainText("由內建規則分析");
    await expect(dialog.getByRole("radio", { name: /主幹＋支線樹/ })).toHaveAttribute("aria-checked", "true");
    await expect(nodeOf(dialog, A!).locator("[data-tg-ai-units-badge]")).toHaveText("跨段整合 3 輪（#1, #3, #5）");
    await expect(nodeOf(dialog, B!)).toContainText("跨段整合 2 輪（#2, #6）");
    await expect(nodeOf(dialog, C!)).toContainText(INTERLEAVED_ROUNDS[3]![1]);
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F16.2", "step2-ai-tree-1440");

    // The rounds of §1 from the keyboard, then #5 split out as a separate conversation.
    const toggle = nodeOf(dialog, A!).locator("[data-tg-node-units-toggle]");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(nodeOf(dialog, A!).locator("[data-tg-ai-unit]")).toHaveCount(3);
    await shoot(page, "F16.2", "step2-ai-units-1440");
    const round5 = nodeOf(dialog, A!).getByRole("combobox", { name: "移動第 #5 輪" });
    // Tab reaches each round's menu in order: #1, #3, then #5.
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("Tab");
    await expect(round5).toBeFocused();
    await round5.selectOption({ label: "拆出成為獨立對話" });
    await expect(nodeOf(dialog, A!).locator("[data-tg-ai-units-badge]")).toHaveText("跨段整合 2 輪（#1, #3）");
    await expect(summary).toContainText("1 個主幹章節、2 條支線、1 篇獨立對話");
    await expect(dialog.getByText(/將建立 2 條主線/)).toBeVisible();
    // Focus followed the round into its new node.
    await expect(nodeOf(dialog, A3!).getByRole("combobox", { name: "移動第 #5 輪" })).toBeFocused();
    const back = nodeOf(dialog, A3!).getByRole("combobox", { name: "移動第 #5 輪" });
    await back.selectOption((await back.locator("option", { hasText: /^§1 / }).getAttribute("value"))!);
    await expect(nodeOf(dialog, A!).locator("[data-tg-ai-units-badge]")).toHaveText("跨段整合 3 輪（#1, #3, #5）");

    await bar.locator("[data-tg-ai-reset]").click();
    await expect(summary).toHaveCount(0);
    await expect(dialog.locator("[data-tg-blueprint-node]")).toHaveCount(1);
    await expect(dialog.getByRole("radio", { name: /時間軸章節圖/ })).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("the bar, the tree and a node's rounds fit the width", async ({ page }) => {
    await page.goto(`/?${Q}`);
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "匯入對話" }).tap();
    const dialog = await openStep2(page, true);
    const bar = dialog.locator("[data-tg-ai-tree-bar]");
    await expect(bar.locator("[data-tg-ai-analyze]")).toBeVisible();
    await expectInside(bar, bar);
    await bar.locator("[data-tg-ai-analyze]").tap();
    await expect(dialog.locator("[data-tg-ai-summary]")).toContainText("1 個主幹章節、2 條支線");
    // The tree is shown as soon as it is drawn.
    await expect(dialog.getByRole("tab", { name: /結構圖/ })).toHaveAttribute("aria-selected", "true");
    const a = nodeOf(dialog, A!);
    await expect(a.locator("[data-tg-ai-units-badge]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await expectInside(a, a);
    await expectInside(nodeOf(dialog, B!), nodeOf(dialog, B!));
    await shoot(page, "F16.2", "step2-ai-tree-375");
    await a.locator("[data-tg-node-units-toggle]").tap();
    await expect(a.locator("[data-tg-ai-unit]")).toHaveCount(3);
    await expectInside(a, a);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "F16.2", "step2-ai-units-375");
  });
});
