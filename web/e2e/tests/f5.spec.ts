import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectAccessible, isApi, MODERATE, shoot, messageAction } from "./helpers";
import { apiCall, apiTurn, composer, freshConversation, replies, sidePanel, turn } from "./flows";
import { backToMain, branchBar, openBranch, openTab } from "./f5-flows";

/**
 * F5 phases 1 and 2 (B9 phases A and B) on the mock and the reference server
 * (fake runner, `goal:suggest,relations:suggest,open_loops,fisheye`): the goal (AI proposal after
 * the 2nd reply, adopted from the capsule, edited with the keyboard), the
 * drift hint under a reply, relations (a reply's 關聯…, the outline's list,
 * the map's layer with the keyboard, delete and undo, AI's dashed one
 * confirmed), pins, the review (C5) from 待處理, fisheye (C1: the send
 * preview item by item, the map's 魚眼 layer) — at 1440, 420 (embedded)
 * and 375 (phone) — and every entry gone with the features off.
 */

const capsule = (page: Page) => page.getByRole("button", { name: /^(目標：|設定目標$)/ });
const goalEditor = (page: Page) => page.getByRole("dialog", { name: "目標" });
const driftHint = (page: Page) => page.getByRole("group", { name: "偏離目標" });
const relationsRegion = (page: Page) => sidePanel(page).getByRole("region", { name: /^關聯/ });

/** The fake runner's (and the mock's) drift purpose. */
const DRIFT_PURPOSE = "Follow the side topic (fake runner)";

/** A conversation without a goal and with two finished replies: the mock's "rust", or a new one on the server. */
async function conversationWithoutGoal(page: Page, info: TestInfo, query: string): Promise<void> {
  if (isApi(info)) {
    const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "F5 goal" }, info);
    await apiTurn(page, line.id, "Where should we stay in Kyoto?", info);
    await page.goto(`/?${query}&line=${line.id}`);
    await expect(replies(page)).toHaveCount(1);
    await turn(page, "And for how long?");
    return;
  }
  await page.goto(`/?${query}&line=rust`);
  await expect(composer(page)).toBeVisible();
  await turn(page, "所有權是什麼？");
  await turn(page, "借用又是什麼？");
}

/** The drift hint under the newest reply: the mock reads `[fake:drift]` at once, the server checks every 4th main-line reply. */
async function driftingConversation(page: Page, info: TestInfo, query: string): Promise<void> {
  await freshConversation(page, info, query, isApi(info) ? 3 : 1, "F5 drift");
  await turn(page, "[fake:drift] 外網存取呢？");
  await expect(driftHint(page)).toBeVisible({ timeout: 20_000 });
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has none of these features"));

  test("goal: AI proposes after the 2nd reply without taking focus; adopted from the capsule, then edited by keyboard", async ({ page }, info) => {
    await conversationWithoutGoal(page, info, "theme=light&lang=zh-TW");
    await expect(composer(page)).toBeFocused();
    // The capsule only marks the proposal: nothing opens, focus stays in the composer.
    await expect(page.getByText("AI 提了一個目標")).toBeAttached({ timeout: 20_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await capsule(page).click();
    const editor = goalEditor(page);
    await expect(editor.getByText("AI 提案：")).toBeVisible();
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F5", `goal-proposal-1440-${info.project.name}`);
    await editor.getByRole("button", { name: "採用" }).click();
    await expect(capsule(page)).toHaveAccessibleName(/^目標：.+/);
    await expect(editor.getByText("來源：AI 提案")).toBeVisible();

    await editor.getByRole("button", { name: "修改" }).click();
    const field = editor.getByRole("textbox", { name: "這段對話的目標" });
    await expect(field).toBeFocused();
    await field.fill("一週內排好京都的住宿");
    await field.press("Enter");
    await expect(capsule(page)).toHaveAccessibleName("目標：一週內排好京都的住宿");
    await expect(editor.getByText("來源：手動")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(capsule(page)).toBeFocused();
    if (!isApi(info)) return;
    await page.reload();
    await expect(capsule(page)).toHaveAccessibleName("目標：一週內排好京都的住宿");
  });

  test("drift: the hint sits under the reply that strayed, takes no focus, and opens the proposed branch", async ({ page }, info) => {
    await driftingConversation(page, info, "theme=light&lang=zh-TW");
    await expect(replies(page).last().getByRole("group", { name: "偏離目標" })).toContainText("這段好像偏離目標");
    // It arrives after the reply; the conversation keeps following the bottom, so it is in view.
    await expect(driftHint(page)).toBeInViewport();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expectAccessible(page, MODERATE, '[role="group"][aria-label="偏離目標"]');
    await shoot(page, "F5", `drift-1440-${info.project.name}`);
    // The fake runner (and the mock) proposes an investigation.
    await driftHint(page).getByRole("button", { name: "開成查證" }).click();
    await expect(branchBar(page)).toContainText(DRIFT_PURPOSE);
  });

  test("relations: a reply's 關聯…, the outline's list, the map by keyboard; delete and undo", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F5 relations");
    await openBranch(page, "Rail passes");
    await backToMain(page);
    await openBranch(page, "Hotel prices");
    await backToMain(page);

    const reply = replies(page).last();
    await reply.hover();
    await messageAction(reply, "關聯…");
    const dialog = page.getByRole("dialog", { name: "建立關聯" });
    await dialog.getByRole("combobox", { name: "連到" }).click();
    await page.getByRole("option", { name: "查證・Rail passes" }).click();
    await dialog.getByRole("textbox", { name: "說明（可留白）" }).fill("同一筆預算");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "建立" }).click();
    await expect(dialog).toBeHidden();

    await openTab(page, "結構");
    await expect(relationsRegion(page).getByText("同一筆預算")).toBeVisible();
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');

    await sidePanel(page).getByRole("radio", { name: "地圖" }).click();
    const map = sidePanel(page).getByRole("group", { name: "支線地圖" });
    await expect(map.getByRole("button", { name: /^關聯 .*同一筆預算$/ })).toBeVisible();
    // Keyboard (interactions.md): focus a node, R, arrows to the other end, Enter, then the note.
    await map.getByRole("button", { name: /^Rail passes/ }).focus();
    await page.keyboard.press("r");
    await expect(sidePanel(page).getByRole("status", { name: "關聯狀態" })).toContainText("正在從「Rail passes」拉關聯");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const note = map.getByRole("textbox", { name: "這兩個節點有什麼關係" });
    await expect(note).toBeFocused();
    await note.fill("都在比價");
    await note.press("Enter");
    const pill = map.getByRole("button", { name: /^關聯 .*都在比價$/ });
    await expect(pill).toBeVisible();
    await shoot(page, "F5", `relations-map-1440-${info.project.name}`);
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');

    // Select it, delete it, bring it back within a few seconds.
    await pill.click();
    await map.getByRole("button", { name: /^刪除關聯/ }).click();
    await expect(pill).toHaveCount(0);
    await sidePanel(page).getByRole("button", { name: "復原" }).click();
    await expect(map.getByRole("button", { name: /^關聯 .*都在比價$/ })).toBeVisible();
  });

  test("relations: after a branch ends AI proposes one, dashed until confirmed", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F5 suggested relation");
    await openBranch(page, "Ryokan prices");
    await backToMain(page);
    await openBranch(page, "Hotel prices");
    await turn(page, "Business hotels near the station?");
    await branchBar(page).getByRole("button", { name: "不帶回" }).click();
    const discard = page.getByRole("dialog", { name: "結束支線，不帶回" });
    await discard.getByRole("button", { name: "結束，不帶回" }).click();
    await expect(discard).toBeHidden();
    await openTab(page, "結構");
    const suggested = relationsRegion(page).getByRole("listitem", { name: /AI 建議・待確認/ });
    await expect(suggested).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await suggested.getByRole("button", { name: "確認" }).click();
    await expect(relationsRegion(page).getByRole("listitem", { name: /AI 建議/ })).toHaveCount(0);
    await expect(relationsRegion(page).getByRole("button", { name: /^前往「查證・Hotel prices」/ })).toBeVisible();
  });

  test("pin: from a reply's action, marked on the message (and kept by the server)", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F5 pin");
    const reply = replies(page).last();
    // F8 S1: with parking on, 釘選 sits in the reply's 「更多動作」.
    await messageAction(reply, "釘選");
    await expect(reply.getByText("已釘選")).toBeVisible();
    await shoot(page, "F5", `pin-1440-${info.project.name}`);
    if (isApi(info)) {
      await page.reload();
      await expect(replies(page).last().getByText("已釘選")).toBeVisible();
    }
    const again = replies(page).last();
    await messageAction(again, "取消釘選");
    await expect(again.getByText("已釘選")).toHaveCount(0);
  });

  test("review: from the bottom of 待處理 — four columns, snooze in this browser, Esc closes", async ({ page }, info) => {
    if (isApi(info)) {
      await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F5 review");
      await composer(page).fill("UPS 要不要買？");
      await composer(page).locator("xpath=..").getByRole("button", { name: "停車" }).click();
      await expect(composer(page)).toHaveValue("");
    } else {
      await page.goto("/?theme=light&lang=zh-TW&line=nas");
      await expect(replies(page).last()).toBeVisible();
    }
    await openTab(page, "待處理");
    if (!isApi(info)) await expect(sidePanel(page).getByRole("region", { name: /^開太久的支線/ }).getByRole("article")).toHaveCount(1);
    await sidePanel(page).getByRole("button", { name: "回顧所有未完成的事" }).click();
    const board = page.getByRole("region", { name: "回顧：還沒收尾的事" });
    await expect(board).toBeVisible();
    for (const column of ["開著太久的支線", "待確認的紀要", "停車場的種子", "未處理的建議"]) await expect(board.getByRole("region", { name: new RegExp(`^${column}`) })).toBeVisible();
    const left = isApi(info) ? 1 : 6;
    await expect(board.getByText(`剩 ${left} 項`)).toBeVisible();
    await expectAccessible(page, MODERATE, 'section[aria-labelledby]:has(h2)');
    await shoot(page, "F5", `review-1440-${info.project.name}`);
    const seed = board.getByRole("region", { name: /^停車場的種子/ }).getByRole("article", { name: "UPS 要不要買？" });
    await seed.getByRole("button", { name: "暫存" }).click();
    await expect(seed).toHaveCount(0);
    await expect(board.getByText(left === 1 ? "都處理完了" : `剩 ${left - 1} 項`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(board).toBeHidden();
  });
});

const previewButton = (page: Page) => page.getByRole("button", { name: /送出前預覽/ });
const previewPane = (page: Page) => page.getByRole("dialog", { name: "送出前預覽" }).or(page.getByRole("region", { name: "送出前預覽" }));
const seesRegion = (page: Page) => previewPane(page).getByRole("region", { name: "這一輪 AI 看得到什麼" });

/** Enough turns that the oldest are condensed: the server keeps 4 rounds whole, the mock 2. */
async function longConversation(page: Page, info: TestInfo, query: string): Promise<void> {
  await freshConversation(page, info, query, isApi(info) ? 6 : 1, "F5 fisheye");
  if (!isApi(info)) for (const text of ["第二題", "第三題"]) await turn(page, text);
}

test.describe("1440 desktop: fisheye (C1, phase 2)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has no fisheye"));

  test("the send preview shows what AI sees item by item, with the budget; a pinned message is always sent", async ({ page }, info) => {
    await longConversation(page, info, "theme=light&lang=zh-TW");
    const first = replies(page).first();
    await messageAction(first, "釘選");
    await expect(first.getByText("已釘選・一定送出")).toBeVisible();
    await previewButton(page).click();
    const sees = seesRegion(page);
    await expect(sees).toBeVisible();
    await expect(sees.getByRole("listitem").filter({ hasText: "一定送出" })).toContainText("完整");
    await expect(sees.getByRole("listitem").filter({ hasText: "摘要" }).first()).toBeVisible();
    await expect(previewPane(page).getByRole("region", { name: "預算分配" })).toContainText("最近訊息");
    await expectAccessible(page, MODERATE, 'section[aria-label="送出前預覽"]');
    await shoot(page, "F5", `fisheye-preview-1440-${info.project.name}`);
  });

  test("the map's 魚眼 layer fades each node by what AI sees", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F5 fisheye map");
    await openBranch(page, "Used hard drives");
    await turn(page, "Are used enterprise drives OK?");
    await branchBar(page).getByRole("button", { name: "不帶回" }).click();
    const discard = page.getByRole("dialog", { name: "結束支線，不帶回" });
    await discard.getByRole("textbox", { name: "原因（選填）" }).fill("保固太短");
    await discard.getByRole("button", { name: "結束，不帶回" }).click();
    await expect(discard).toBeHidden();
    await backToMain(page);
    await openTab(page, "結構");
    await sidePanel(page).getByRole("radio", { name: "地圖" }).click();
    await sidePanel(page).getByRole("group", { name: "地圖圖層" }).getByRole("button", { name: "魚眼" }).click();
    const map = sidePanel(page).getByRole("group", { name: "支線地圖" });
    await expect(map.getByRole("button", { name: /^Used hard drives，.*AI 看到：只有一句收尾$/ })).toBeVisible();
    await expect(map.getByRole("button", { name: /^主線，.*AI 看到：完整$/ })).toBeVisible();
    await expect(sidePanel(page).getByRole("list", { name: "透明度＝AI 看到多少" })).toBeVisible();
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
    await shoot(page, "F5", `fisheye-map-1440-${info.project.name}`);
  });
});

/** The mock's C1 set (`?features=c1`) and the core-only server have no goal, relations or open loops. */
async function openWithout(page: Page, info: TestInfo): Promise<void> {
  if (info.project.name === "mock") {
    await page.goto("/?theme=light&lang=zh-TW&features=c1&line=nas");
    await expect(replies(page).last()).toBeVisible();
    return;
  }
  const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "F5 off" }, info);
  await apiTurn(page, line.id, "Hello", info);
  await page.goto(`/?theme=light&lang=zh-TW&line=${line.id}`);
  await expect(replies(page)).toHaveCount(1);
}

test.describe("1440, features off", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no goal, no relations, no review — pins stay (core)", async ({ page }, info) => {
    test.skip(info.project.name === "api", "the api server runs them on; api-core and the mock's C1 set do not");
    await openWithout(page, info);
    await expect(capsule(page)).toHaveCount(0);
    const last = replies(page).last();
    await last.hover();
    await expect(last.getByRole("button", { name: "關聯…" })).toHaveCount(0);
    await expect(last.getByRole("button", { name: "釘選" })).toBeVisible();
    await expect(relationsRegion(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "回顧所有未完成的事" })).toHaveCount(0);
    await expect(driftHint(page)).toHaveCount(0);
    // No fisheye either: the pin only says 已釘選, the preview has no fisheye part, the map no 魚眼 layer.
    await last.getByRole("button", { name: "釘選" }).click();
    await expect(last.getByText("已釘選", { exact: true })).toBeVisible();
    await previewButton(page).click();
    await expect(previewPane(page).getByRole("region", { name: "預算分配" })).toBeVisible();
    await expect(seesRegion(page)).toHaveCount(0);
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the goal from the compact capsule, and a drift hint that fits", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no goal on the core-only server");
    await driftingConversation(page, info, "frame=embed&lang=zh-TW");
    const box = await driftHint(page).boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(420);
    await capsule(page).click();
    await expect(goalEditor(page)).toBeVisible();
    await shoot(page, "F5", `goal-420-${info.project.name}`);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(goalEditor(page)).toBeHidden();
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("pin by touch, then the review full screen from the bottom sheet", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no open loops on the core-only server");
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F5 phone");
    const reply = replies(page).last();
    // F8 S1: touch screens act from the label row's 「更多動作」 sheet (rows 44px).
    const more = reply.getByRole("button", { name: "更多動作" });
    expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await more.tap();
    const pin = page.getByRole("dialog").getByRole("button", { name: "釘選", exact: true });
    expect((await pin.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await pin.tap();
    await expect(reply.getByText("已釘選")).toBeVisible();
    await page.getByRole("button", { name: "大綱" }).tap();
    await openTab(page, "待處理");
    await sidePanel(page).getByRole("button", { name: "回顧所有未完成的事" }).tap();
    const board = page.getByRole("region", { name: "回顧：還沒收尾的事" });
    await expect(board).toBeVisible();
    const close = board.getByRole("button", { name: "關閉回顧" });
    expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "F5", `review-375-${info.project.name}`);
    await expectAccessible(page);
    await close.tap();
    await expect(board).toBeHidden();
  });

  test("the send preview's fisheye in the phone drawer", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no fisheye on the core-only server");
    await longConversation(page, info, "theme=light&lang=zh-TW");
    await previewButton(page).tap();
    await expect(seesRegion(page)).toBeVisible();
    await expect(seesRegion(page).getByRole("listitem").first()).toContainText(/完整|摘要|只有一句收尾|看不到/);
    await shoot(page, "F5", `fisheye-preview-375-${info.project.name}`);
    await expectAccessible(page);
  });
});
