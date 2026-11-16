import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MINDMAP_ROUNDS, mindmapConversation } from "../../packages/client/src/import-mindmap-fixtures";
import { Q } from "./f14-flows";
import { expectAccessible, isApi, SERIOUS, shoot } from "./helpers";

/**
 * F17 (docs/prompts/F17.md, Claude Design 2026-11-04) on the mock: step 2's
 * mind map workspace on the design's nine rounds. 1440: the 1340-wide step,
 * the canvas beside the 460 inspector with no node clipped or overlapping,
 * full width, the turn order with labels apart, the inspector's rounds and
 * card, dragging a round onto a node and a node onto a chapter at 80%, a
 * moved fork round, analyzing again after changes, axe in light and dark,
 * and 120 conversations; 375: the canvas over its details, the original
 * order list and the bottom sheet that moves a round, nothing wider than
 * the screen.
 */

test.beforeEach(({}, info) => test.skip(isApi(info), "F17 runs on the mock's scenario"));
test.use({ timezoneId: "Asia/Taipei" });

const [Q1, Q2, , Q4, , , Q7, Q8] = MINDMAP_ROUNDS.map(([question]) => question);
const TITLE = "電腦散熱與硬體維護雜談";

function fileOf(name: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tangent-f17-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

/** A word of its own for conversation `i` ("qaa", "qab", …): no two topics share a word, so none are threaded together. */
const wordOf = (i: number) => `q${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;

/** 120 Claude conversations, a day apart, each of two rounds (the F16.1 scale). */
function manyConversations(): unknown[] {
  return Array.from({ length: 120 }, (_, i) => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 6, 1 + i, 2, minutes)).toISOString();
    const word = wordOf(i);
    return {
      uuid: `f17-${i}`,
      name: word,
      created_at: at(0),
      updated_at: at(3),
      chat_messages: [0, 1, 2, 3].map((k) => ({ uuid: `f17-${i}-${k}`, sender: k % 2 ? "assistant" : "human", text: k % 2 ? `${word}.` : `${word}?`, created_at: at(k) })),
    };
  });
}

const nodeOf = (dialog: Locator, title: string) => dialog.locator("[data-tg-mindmap-node]").filter({ hasText: title });
const scrollWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

async function openImport(page: Page, tap: boolean, query = Q) {
  await page.goto(`/?${query}`);
  if (tap) {
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "匯入對話" }).tap();
  } else await page.getByRole("button", { name: "匯入對話" }).click();
  return page.getByRole("dialog", { name: "匯入對話" });
}

/** The nine rounds on step 2, analyzed, on the mind map. */
async function mindMap(page: Page, { tap = false, query = Q } = {}) {
  const dialog = await openImport(page, tap, query);
  await page.locator('input[type="file"]').setInputFiles(fileOf("電腦散熱.json", mindmapConversation()));
  await expect(dialog.getByRole("checkbox", { name: TITLE })).toHaveAttribute("aria-checked", "true");
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  await press(dialog.getByRole("button", { name: tap ? "下一步：排序與結構" : "下一步：時間序拼圖預覽" }));
  await expect(dialog.getByRole("radio", { name: tap ? "清單" : "雙欄時間序清單" })).toHaveAttribute("aria-checked", "true");
  await press(dialog.locator("[data-tg-ai-analyze]"));
  await expect(dialog.locator("[data-tg-ai-summary]")).toContainText(tap ? "2 個章節・2 條支線・1 篇獨立" : "2 個主幹章節、2 條支線、1 篇獨立對話");
  await press(dialog.locator("[data-tg-view-mindmap]"));
  await expect(dialog.getByRole("tree", { name: "結構心智圖" })).toBeVisible();
  return dialog;
}

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

async function boxesOf(cards: Locator): Promise<Box[]> {
  return Promise.all((await cards.all()).map(async (card) => (await card.boundingBox())!));
}

/** An HTML5 drag whose target appears only once the drag has started (the zones, 「將第 #n 輪併入此節點」). */
async function dragOnto(page: Page, source: Locator, target: () => Locator) {
  await source.hover();
  await page.mouse.down();
  const box = (await source.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 });
  await target().hover();
  await page.mouse.up();
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("S1–S4: the 1340 workspace, the tree inside its canvas, full width, the turn order and the inspector", async ({ page }) => {
    const dialog = await mindMap(page);
    const frame = (await dialog.boundingBox())!;
    expect(Math.round(frame.width)).toBe(1340);
    const canvas = (await dialog.locator("[data-tg-mindmap-canvas]").boundingBox())!;
    const details = (await dialog.getByRole("complementary", { name: "節點問答明細" }).boundingBox())!;
    expect(Math.round(details.width)).toBe(460);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(details.x + 0.5);
    expect(Math.round(canvas.width)).toBe(880);
    // Every card fits the canvas' width at 100%, and none covers another.
    const cards = await boxesOf(dialog.locator('[data-tg-mindmap-canvas] [role="treeitem"]'));
    expect(cards).toHaveLength(6);
    for (const card of cards) {
      expect(card.x).toBeGreaterThanOrEqual(canvas.x);
      expect(card.x + card.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    }
    cards.forEach((a, i) => cards.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
    await expect(nodeOf(dialog, Q1!)).toHaveAttribute("aria-selected", "true");
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F17", "mindmap-canvas-1440");

    // S3: #1→#6 drawn with five labels, no two closer than 22 px.
    await dialog.locator("[data-tg-mindmap-trace-toggle]").click();
    const labels = dialog.locator("[data-tg-mindmap-trace-label]");
    await expect(labels).toHaveText(["1→2", "2→3", "3→4", "4→5", "5→6"]);
    const centres = (await boxesOf(labels)).map((box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 }));
    centres.forEach((a, i) => centres.slice(i + 1).forEach((b) => expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(22)));
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F17", "mindmap-trace-1440");
    await dialog.locator("[data-tg-mindmap-trace-toggle]").click();

    // S2 full width: the inspector folds away; choosing a node brings it back.
    await dialog.getByRole("button", { name: "全幅心智圖（收合明細欄）" }).click();
    await expect(dialog.getByRole("complementary", { name: "節點問答明細" })).toHaveCount(0);
    await expect(dialog.getByText("點一個節點，在右側看問答明細")).toBeVisible();
    expect(Math.round((await dialog.locator("[data-tg-mindmap-canvas]").boundingBox())!.width)).toBe(1340);
    await shoot(page, "F17", "mindmap-full-1440");
    await nodeOf(dialog, Q2!).click();
    const inspector = dialog.getByRole("complementary", { name: "節點問答明細" });
    await expect(inspector).toBeVisible();

    // S4: the branch's role, where it hangs, its card and its rounds.
    await expect(inspector.getByRole("radio", { name: "掛為支線" })).toHaveAttribute("aria-checked", "true");
    await expect(inspector.getByRole("combobox", { name: /在哪一輪之後分岔/ })).toHaveValue(/#turn-1$/);
    await expect(inspector.locator("[data-tg-inspector-reason]")).toContainText("AI 歸納理由：");
    const round = inspector.locator("[data-tg-inspector-round]").first();
    await expect(round).toContainText(`提問：${Q2}`);
    await round.getByRole("button", { name: "展開完整回覆" }).click();
    await expect(round.getByRole("button", { name: "收合回覆" })).toHaveAttribute("aria-expanded", "true");
    await inspector.getByRole("textbox", { name: `「${Q2}」的結論` }).fill("個人專案選 Supabase");
    await expect(nodeOf(dialog, Q2!)).toContainText("個人專案選 Supabase");
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F17", "mindmap-branch-1440");
  });

  test("S5: drags a round onto a node, and a node onto a chapter at 80%; a moved fork round warns; analyzing again asks", async ({ page }) => {
    const dialog = await mindMap(page);
    const inspector = dialog.getByRole("complementary", { name: "節點問答明細" });
    // S5b: #5 from §1's rounds onto the AIO branch.
    const aio = (await nodeOf(dialog, Q4!).getAttribute("data-tg-mindmap-node"))!;
    await dragOnto(page, inspector.getByRole("button", { name: "拖曳第 #5 輪" }), () => dialog.locator(`[data-tg-mindmap-drop-turn="${aio}"]`));
    await expect(nodeOf(dialog, Q4!).locator("[data-tg-mindmap-chip]")).toHaveText(["#4", "#5"]);
    await expect(nodeOf(dialog, Q1!).locator("[data-tg-mindmap-chip]")).toHaveText(["#1", "#3"]);
    await expect(dialog.locator("[data-tg-step-status]")).toContainText("已把 #5 移到");

    // S5a at 80%: the AIO branch onto 「掛在 §2 下當支線」 (hit testing follows the zoom).
    await dialog.getByRole("button", { name: "縮小" }).click();
    await expect(dialog.locator("[data-tg-mindmap-zoom]")).toHaveText("80%");
    const s2 = (await nodeOf(dialog, Q8!).getAttribute("data-tg-mindmap-node"))!;
    await dragOnto(page, nodeOf(dialog, Q4!), () => dialog.locator(`[data-tg-mindmap-drop-branch="${s2}"]`));
    await expect(dialog.locator("[data-tg-mindmap-fork]").nth(1)).toContainText("自 §2");
    await shoot(page, "F17", "mindmap-dropped-80-1440");
    await dialog.getByRole("button", { name: "置中適應" }).click();

    // Decision #6: the Firebase branch forks after #1; #1 leaves §1, so it forks after §1's first round left (#3), flagged.
    await nodeOf(dialog, Q1!).click();
    await inspector.getByRole("button", { name: "把第 #1 輪移至其他節點" }).click();
    await page.getByRole("menuitemradio", { name: "拆成獨立對話" }).click();
    const moved = dialog.locator('[data-tg-mindmap-fork="moved"]');
    await expect(moved).toContainText("分岔點已移動");
    await expect(dialog.locator("[data-tg-step-status]")).toContainText("分岔點已移動");
    await nodeOf(dialog, Q2!).click();
    await expect(inspector.locator("[data-tg-inspector-fork-moved]")).toContainText("已改掛在 #3 之後");
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F17", "mindmap-fork-moved-1440");
    await inspector.getByRole("button", { name: "確認分岔點" }).click();
    await expect(moved).toHaveCount(0);

    // Decision #8: the adjusted tree is not replaced without asking.
    await dialog.locator("[data-tg-ai-analyze]").click();
    const ask = dialog.getByRole("group", { name: "重新分析會取代目前的調整，確定重新分析？" });
    await expect(ask.getByRole("button", { name: "確定重新分析" })).toBeFocused();
    await shoot(page, "F17", "mindmap-reanalyze-confirm-1440");
    await ask.getByRole("button", { name: "確定重新分析" }).click();
    await expect(nodeOf(dialog, Q1!).locator("[data-tg-mindmap-chip]")).toHaveText(["#1", "#3", "#5"]);
    await dialog.locator("[data-tg-ai-reset]").click();
    await expect(dialog.locator("[data-tg-mindmap-node]")).toHaveCount(1);
  });

  test("the keyboard walks the tree and opens the details; dark theme passes axe", async ({ page }) => {
    const dialog = await mindMap(page, { query: "theme=dark&lang=zh-TW" });
    await nodeOf(dialog, Q1!).focus();
    await page.keyboard.press("ArrowRight");
    await expect(nodeOf(dialog, Q2!)).toBeFocused();
    await expect(nodeOf(dialog, Q2!)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(nodeOf(dialog, Q4!)).toBeFocused();
    await page.keyboard.press("End");
    await expect(nodeOf(dialog, Q7!)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("heading", { level: 3, name: Q7 })).toBeFocused();
    await dialog.locator("[data-tg-mindmap-trace-toggle]").click();
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F17", "mindmap-trace-dark-1440");
  });

  test("120 conversations: the timeline as a map that scrolls and fits, without overlaps, before and after an analysis", async ({ page }) => {
    const dialog = await openImport(page, false);
    await page.locator('input[type="file"]').setInputFiles(fileOf("conversations.json", manyConversations()));
    await expect(dialog.getByText("Claude・120 篇", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "全選符合的" }).click();
    await dialog.getByRole("button", { name: "下一步：時間序拼圖預覽" }).click();
    await dialog.locator("[data-tg-view-mindmap]").click();
    const items = dialog.locator('[data-tg-mindmap-canvas] [role="treeitem"]');
    await expect(items).toHaveCount(121);
    const cards = await boxesOf(dialog.locator("[data-tg-mindmap-node]"));
    cards.forEach((a, i) => cards.slice(i + 1, i + 4).forEach((b) => expect(overlap(a, b)).toBe(false)));
    await dialog.getByRole("button", { name: "置中適應" }).click();
    await expect(dialog.locator("[data-tg-mindmap-zoom]")).toHaveText("25%");
    await nodeOf(dialog, wordOf(119)).click();
    await expect(dialog.getByRole("complementary", { name: "節點問答明細" })).toContainText(`提問：${wordOf(119)}?`);
    await shoot(page, "F17", "mindmap-120-fit-1440");
    // Analyzed whole (one unit each): still drawn, every card in place.
    await dialog.locator("[data-tg-ai-analyze]").click();
    await expect(dialog.locator("[data-tg-ai-summary]")).toBeVisible();
    await expect(dialog.locator("[data-tg-mindmap-node]")).toHaveCount(120);
    const after = await boxesOf(dialog.locator("[data-tg-mindmap-node]"));
    after.forEach((a, i) => after.slice(i + 1, i + 4).forEach((b) => expect(overlap(a, b)).toBe(false)));
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("the canvas over its details, the original order as a list, and a bottom sheet instead of dragging", async ({ page }) => {
    const dialog = await mindMap(page, { tap: true });
    await expect(dialog.getByRole("tab", { name: /結構圖/ })).toHaveAttribute("aria-selected", "true");
    await expect(dialog.locator("[data-tg-mindmap-node][draggable]")).toHaveCount(0);
    expect(await scrollWidth(page)).toBeLessThanOrEqual(375);
    await expectAccessible(page, SERIOUS, '[role="dialog"]');
    await shoot(page, "F17", "mindmap-375");

    await dialog.getByRole("button", { name: "顯示穿插順序" }).tap();
    const order = dialog.locator("[data-tg-mindmap-trace-list]");
    await expect(order).toContainText("原對話的穿插順序");
    await expect(order.locator("[data-tg-trace-row]")).toHaveCount(6);
    await order.locator('[data-tg-trace-row="3"]').tap();
    await expect(nodeOf(dialog, Q1!)).toHaveAttribute("aria-selected", "true");
    await shoot(page, "F17", "mindmap-trace-list-375");
    await dialog.getByRole("button", { name: "顯示穿插順序" }).tap();

    const inspector = dialog.getByRole("complementary", { name: "節點問答明細" });
    const move = inspector.getByRole("button", { name: "把第 #5 輪移至其他節點" });
    await move.scrollIntoViewIfNeeded();
    await move.tap();
    const sheet = page.getByRole("dialog", { name: "把第 #5 輪移到…" });
    await expect(sheet).toBeVisible();
    for (const row of await sheet.getByRole("menuitemradio").all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "F17", "mindmap-move-sheet-375");
    await sheet.getByRole("menuitemradio", { name: "拆成獨立對話" }).tap();
    await expect(nodeOf(dialog, Q1!).locator("[data-tg-mindmap-chip]")).toHaveText(["#1", "#3"]);
    expect(await scrollWidth(page)).toBeLessThanOrEqual(375);
  });
});
