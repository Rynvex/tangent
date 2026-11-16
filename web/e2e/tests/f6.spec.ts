import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { argBadge, expectAccessible, isApi, MODERATE, messageAction, setArgType, shoot } from "./helpers";
import { apiCall, apiTurn, composer, E2E_GOAL, freshConversation, replies, sidePanel, turn } from "./flows";
import { backToMain, openBranch, openTab, outlineRow } from "./f5-flows";

/**
 * F6 phase 1 (B10 phase A) on the mock and the reference server (fake runner,
 * `ibis:suggest,fold:suggest`): argument tags (AI's drafts confirmed, the
 * user's own set and changed, the outline and the map's layer), folds (from a
 * message, drafted by AI, expanded, in the send preview, unfolded) and AI's
 * fold suggestion from 待處理 — at 1440, 420 (embedded) and 375 (phone) — and
 * none of it with the features off.
 */

const Q = "theme=light&lang=zh-TW";
const FOLD_SUMMARY = "This stretch of the conversation is folded (fake runner).";
const foldBlock = (page: Page) => page.locator("section[data-tg-fold]");

/** Opens 從這則起折疊… on the line's first message and folds it through the n-th later one (AI drafts the summary). */
async function foldFromFirst(page: Page, through: number): Promise<void> {
  const first = page.locator("[data-tg-message]").first();
  await first.hover();
  await messageAction(first, "從這則起折疊…");
  const dialog = page.getByRole("dialog", { name: "折疊成摘要" });
  await dialog.getByRole("combobox", { name: "折疊到" }).selectOption({ index: through - 1 });
  await expectAccessible(page, MODERATE, '[role="dialog"]');
  await dialog.getByRole("button", { name: "折疊" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("1440 desktop: argument tags and folds (D2, D4)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has neither"));

  test("tags: AI's drafts are dashed with 待確認 and confirmed in one press; the user's own type is set from 「更多動作」", async ({ page }, info) => {
    // The server tags every 3rd reply (B10 phase B); the mock after each turn.
    await freshConversation(page, info, Q, isApi(info) ? 3 : 1, "F6 tags");
    if (!isApi(info)) await turn(page, "再問一題");
    const row = replies(page).last();
    const badge = argBadge(row);
    await expect(badge).toHaveAttribute("data-tg-arg-badge", "draft", { timeout: 20_000 });
    await expect(badge).toHaveText("想法・待確認");
    await expectAccessible(page, MODERATE, "main");
    await shoot(page, "F6", `tags-1440-${info.project.name}`);
    await badge.hover();
    await row.getByRole("button", { name: "確認類型「想法」" }).click();
    await expect(badge).toHaveAttribute("data-tg-arg-badge", "confirmed");
    // The badge changes once the server has it: reload only once the PUT that writes "decision" is answered (R11 J4).
    const saved = isApi(info)
      ? page.waitForResponse((response) => response.request().method() === "PUT" && /\/messages\/[^/]+\/tag$/.test(new URL(response.url()).pathname) && (response.request().postData() ?? "").includes('"decision"'))
      : null;
    await setArgType(row, "決定");
    await expect(badge).toHaveText("決定");
    if (!saved) return;
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(argBadge(replies(page).last())).toHaveText("決定");
  });

  test("tags: a branch names the type it forks from in the outline, and the map's 論證類型 layer labels it", async ({ page }, info) => {
    await freshConversation(page, info, Q, isApi(info) ? 3 : 1, "F6 anchor tag");
    const row = replies(page).last();
    await expect(argBadge(row)).toHaveAttribute("data-tg-arg-badge", "draft", { timeout: 20_000 });
    await setArgType(row, "問題");
    await expect(argBadge(row)).toHaveText("問題");
    await openBranch(page, "Temple passes");
    await backToMain(page);
    await openTab(page, "結構");
    await expect(outlineRow(page, "Temple passes")).toHaveAccessibleName(/分岔處是「問題」/);
    await sidePanel(page).getByRole("radio", { name: "地圖" }).click();
    await sidePanel(page).getByRole("group", { name: "地圖圖層" }).getByRole("button", { name: "論證類型" }).click();
    const map = sidePanel(page).getByRole("group", { name: "支線地圖" });
    await expect(map.getByRole("button", { name: /^Temple passes，.*分岔處是「問題」$/ })).toContainText("問題");
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
  });

  test("folds: from a message's action, AI drafts the summary; expanded shows the original; the preview lists it; unfold brings it back", async ({ page }, info) => {
    test.slow();
    await freshConversation(page, info, Q, isApi(info) ? 3 : 1, "F6 fold");
    if (!isApi(info)) for (const text of ["第二題", "第三題"]) await turn(page, text);
    await foldFromFirst(page, 3);
    const block = foldBlock(page).first();
    await expect(block).toContainText(FOLD_SUMMARY, { timeout: 20_000 });
    await expect(block).toContainText(/送給 AI 時只送摘要：\d+ token（原本 [\d.]+k?）/);
    const toggle = block.getByRole("button", { name: /^已折疊 #\d+–#\d+/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(block.getByRole("region", { name: "原文" }).locator("[data-tg-message]")).toHaveCount(4);
    await expectAccessible(page, MODERATE, "main");
    await shoot(page, "F6", `fold-1440-${info.project.name}`);
    await page.getByRole("button", { name: /送出前預覽/ }).click();
    const preview = page.getByRole("dialog", { name: "送出前預覽" }).or(page.getByRole("region", { name: "送出前預覽" }));
    await expect(preview.getByRole("region", { name: "折疊" }).getByRole("listitem")).toHaveCount(1);
    await page.keyboard.press("Escape");
    // 改摘要 (PATCH /folds/{fid}): the user's summary replaces AI's.
    await block.getByRole("button", { name: "改摘要" }).click();
    const field = block.getByRole("textbox", { name: "摘要" });
    await field.fill("比較了京都的寺廟與交通");
    await block.getByRole("button", { name: "儲存" }).click();
    await expect(block).toContainText("摘要：比較了京都的寺廟與交通");
    await block.getByRole("button", { name: "取消折疊" }).click();
    await expect(foldBlock(page)).toHaveCount(0);
  });

  test("folds: AI's suggestion arrives in 待處理 without popping up; accepting folds those messages", async ({ page }, info) => {
    test.slow();
    if (isApi(info)) {
      const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "F6 fold suggestion" }, info);
      await apiCall(page, "put", `/lines/${line.id}/goal`, { text: E2E_GOAL }, info);
      const long = (n: number) => `Question ${n}: ${"we keep comparing temples, rail passes and food markets for the Kyoto trip; ".repeat(14)}`;
      for (let n = 1; n <= 5; n += 1) await apiTurn(page, line.id, long(n), info);
      const messages = (await apiCall<{ messages: Array<{ id: string; role: string }> }>(page, "get", `/lines/${line.id}/messages`, undefined, info)).messages;
      const fifth = messages.filter((message) => message.role === "user").at(-1)!;
      await apiCall(page, "post", `/lines/${line.id}/chapters/milestones`, { messageId: fifth.id, title: "Second part" }, info);
      for (let n = 6; n <= 10; n += 1) await apiTurn(page, line.id, `Short question ${n}`, info);
      await page.goto(`/?${Q}&line=${line.id}`);
      await expect(replies(page)).toHaveCount(10);
    } else {
      await freshConversation(page, info, Q, 1, "F6 fold suggestion");
      await turn(page, "[fake:fold-suggest] 幫我整理一下");
    }
    await expect(composer(page)).toBeVisible();
    await openTab(page, "待處理");
    const card = sidePanel(page).getByRole("article", { name: "建議：折疊" }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(/每輪約可省 [\d.]+k? token/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await card.getByRole("button", { name: "接受" }).click();
    await expect(card).toContainText("已接受");
    await expect(foldBlock(page).first()).toContainText(FOLD_SUMMARY);
  });
});

/** 給我幾個方向… on the last reply: the dialog, then the marker with the directions under the reply. */
async function divergeFromLast(page: Page, count: number): Promise<void> {
  const reply = replies(page).last();
  await reply.hover();
  await messageAction(reply, "給我幾個方向…");
  const dialog = page.getByRole("dialog", { name: "給我幾個方向" });
  await dialog.getByRole("radiogroup", { name: "幾個方向" }).getByRole("radio", { name: String(count) }).check();
  await expectAccessible(page, MODERATE, '[role="dialog"]');
  await dialog.getByRole("button", { name: `給我 ${count} 個方向` }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

const marker = (page: Page, count: number) => page.getByRole("region", { name: `發散：${count} 個方向` });

test.describe("1440 desktop: diverge and converge (D3)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has no diverge"));

  test("給我 3 個方向 → compare two (with criteria) → the table → one press writes the decision", async ({ page }, info) => {
    test.slow();
    await freshConversation(page, info, Q, 1, "F6 diverge");
    await divergeFromLast(page, 3);
    const directions = marker(page, 3);
    await expect(directions).toBeVisible();
    await expect(directions.getByRole("listitem")).toHaveCount(3);
    await directions.getByRole("checkbox", { name: "比較「Direction 1 (fake runner)」" }).check();
    await directions.getByRole("checkbox", { name: "比較「Direction 2 (fake runner)」" }).check();
    await directions.getByRole("textbox", { name: /^條件/ }).fill("成本\n維護");
    await directions.getByRole("button", { name: "比較 2 條" }).click();
    const table = directions.getByRole("table", { name: "比較表" });
    await expect(table).toBeVisible({ timeout: 20_000 });
    await expect(table.getByRole("rowheader")).toHaveText(["成本", "維護"]);
    await expect(table.getByRole("columnheader")).toHaveText(["條件", "Direction 1 (fake runner)", "Direction 2 (fake runner)"]);
    await expect(directions.getByText("建議：Direction 1 (fake runner)")).toBeVisible();
    await expectAccessible(page, MODERATE, "main");
    await shoot(page, "F6", `compare-1440-${info.project.name}`);
    await directions.getByRole("button", { name: "產生「決定」收尾" }).click();
    await expect(directions.getByText("決定：Direction 1 (fake runner)")).toBeVisible();
    await expect(directions.getByText("其他 1 條以「未帶回」收尾。")).toBeVisible();
    await expect(directions.getByRole("listitem").filter({ hasText: "Direction 2 (fake runner)" })).toContainText("沒選：改走「Direction 1 (fake runner)」");
  });
});

/** A word of this run only: the server's memories are the tenant's, shared by every test of the run. */
const runWord = () => `zx${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

async function newConversation(page: Page, drawer = false): Promise<void> {
  await page.goto(`/?${Q}`);
  if (drawer) await page.getByRole("button", { name: "展開對話清單" }).click();
  await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "新對話" }).first().click();
  await expect(page.getByText("還沒有訊息。在下方輸入第一則。")).toBeVisible();
}

/** From the notes' footer to the library (a modal dialog), where a memory is written and then replaced; Esc closes it and focus goes back to 記憶庫. */
async function rememberInLibrary(page: Page, info: TestInfo, first: string, replaced: string): Promise<void> {
  await openTab(page, "紀要");
  const footer = sidePanel(page).getByRole("region", { name: "跨對話記憶" });
  await expect(footer).toBeVisible();
  await footer.getByRole("button", { name: "記憶庫" }).click();
  const library = page.getByRole("dialog", { name: "記憶庫" });
  await expect(library).toHaveAttribute("aria-modal", "true");
  const add = library.getByRole("form", { name: "新增記憶" });
  await add.getByRole("combobox", { name: "種類" }).selectOption("decision");
  await add.getByRole("textbox", { name: "內容" }).fill(first);
  await add.getByRole("button", { name: "記住" }).click();
  const card = library.getByRole("article", { name: first });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "取代…" }).click();
  await card.getByRole("textbox", { name: "新的內容" }).fill(replaced);
  await card.getByRole("button", { name: "取代", exact: true }).click();
  const current = library.getByRole("article", { name: replaced });
  await expect(current.locator("s")).toHaveText(first);
  await expectAccessible(page, MODERATE, '[role="dialog"]');
  await shoot(page, "F6", `memory-library-${page.viewportSize()?.width ?? 0}-${info.project.name}`);
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();
  await expect(footer.getByRole("button", { name: "記憶庫" })).toBeFocused();
}

test.describe("1440 desktop: cross-conversation memory (D1)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has no memory"));

  test("the library writes and replaces; a new conversation recalls it without popping up, brings it in, and the preview lists it", async ({ page }, info) => {
    test.slow();
    const word = runWord();
    await newConversation(page);
    await rememberInLibrary(page, info, `UPS ${word} 要買 600VA 的`, `UPS ${word} 要買 1000VA 的`);
    await composer(page).fill(`UPS ${word} 該買多大的？`);
    const recall = page.getByRole("region", { name: "你之前得出過" });
    await expect(recall).toContainText(`UPS ${word} 要買 1000VA 的`, { timeout: 15_000 });
    await expect(recall).not.toContainText("600VA");
    await expect(composer(page)).toBeFocused();
    await expectAccessible(page, MODERATE, "main");
    await shoot(page, "F6", `memory-recall-1440-${info.project.name}`);
    await recall.getByRole("button", { name: "帶入這 1 條" }).click();
    await expect(composer(page)).toHaveValue(new RegExp(`^之前得出過：\\n- \\[決定\\] UPS ${word} 要買 1000VA 的\\n\\nUPS ${word} 該買多大的？$`));
    await expect(page.getByText("已在訊息開頭帶入 1 條，會出現在送出前預覽。")).toBeVisible();
    await page.getByRole("button", { name: /送出前預覽/ }).click();
    const preview = page.getByRole("dialog", { name: "送出前預覽" }).or(page.getByRole("region", { name: "送出前預覽" }));
    await expect(preview.getByRole("region", { name: "記憶（跨對話）" })).toContainText(`UPS ${word} 要買 1000VA 的`);
    await page.keyboard.press("Escape");
  });

  test("the branch form offers what was concluded about its purpose, to tick into the background", async ({ page }, info) => {
    const word = runWord();
    await freshConversation(page, info, Q, 1, "F6 memory branch");
    await rememberInLibrary(page, info, `Restore ${word} tests monthly`, `Restore ${word} tests every month`);
    const from = replies(page).last();
    await from.hover();
    await messageAction(from, "從這則開支線");
    const dialog = page.getByRole("dialog", { name: "開支線" });
    await dialog.getByRole("textbox", { name: /目的/ }).fill(`How often to restore ${word} tests`);
    const recall = dialog.getByRole("group", { name: "帶入之前得出過的" });
    await recall.getByRole("checkbox", { name: `帶入「Restore ${word} tests every month」` }).check({ timeout: 15_000 });
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "開支線" }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe("1440, the features off", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no tag controls, no 從這則起折疊… or 給我幾個方向…, no fold blocks (core)", async ({ page }, info) => {
    test.skip(info.project.name === "api", "the api server runs them on; api-core and the mock's C1 set do not");
    if (info.project.name === "mock") {
      await page.goto(`/?${Q}&features=c1&line=nas`);
      await expect(replies(page).last()).toBeVisible();
    } else {
      const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "F6 off" }, info);
      await apiTurn(page, line.id, "Hello", info);
      await page.goto(`/?${Q}&line=${line.id}`);
      await expect(replies(page)).toHaveCount(1);
    }
    const last = replies(page).last();
    await last.hover();
    await expect(last.getByRole("button", { name: "釘選" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /的論證類型$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "從這則起折疊…" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "給我幾個方向…" })).toHaveCount(0);
    await expect(foldBlock(page)).toHaveCount(0);
    await expect(page.getByRole("region", { name: "跨對話記憶" })).toHaveCount(0);
  });
});

async function narrowConversation(page: Page, info: TestInfo, query: string, title: string): Promise<void> {
  await freshConversation(page, info, query, isApi(info) ? 3 : 1, title);
  if (!isApi(info)) for (const text of ["第二題", "第三題"]) await turn(page, text);
}

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the tag control and the fold dialog fit the frame", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "neither on the core-only server");
    await narrowConversation(page, info, "frame=embed&lang=zh-TW", "F6 embed");
    const badge = argBadge(replies(page).last());
    await expect(badge).toHaveAttribute("data-tg-arg-badge", "draft", { timeout: 20_000 });
    const box = await badge.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(420);
    await foldFromFirst(page, 3);
    await expect(foldBlock(page).first()).toContainText(FOLD_SUMMARY, { timeout: 20_000 });
    await shoot(page, "F6", `fold-420-${info.project.name}`);
    await expectAccessible(page);
    // D3 in the frame: the directions and the table scroll inside it, never the page.
    await divergeFromLast(page, 2);
    const directions = marker(page, 2);
    await directions.getByRole("checkbox", { name: /^比較「Direction 1/ }).check();
    await directions.getByRole("checkbox", { name: /^比較「Direction 2/ }).check();
    await directions.getByRole("button", { name: "比較 2 條" }).click();
    await expect(directions.getByRole("table", { name: "比較表" })).toBeVisible({ timeout: 20_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
    await shoot(page, "F6", `compare-420-${info.project.name}`);
    await expectAccessible(page);
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("the memory library full screen from the notes' footer, then the recall above the composer", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no memory on the core-only server");
    const word = runWord();
    await newConversation(page, true);
    await page.getByRole("button", { name: "大綱" }).tap();
    await rememberInLibrary(page, info, `Fans ${word} must be quiet`, `Fans ${word} must be silent`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Back in the notes sheet the library was opened from; Esc closes it too.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "側欄" })).toBeHidden();
    await composer(page).fill(`Which fans ${word}?`);
    const recall = page.getByRole("region", { name: "你之前得出過" });
    await expect(recall).toBeVisible({ timeout: 15_000 });
    const use = recall.getByRole("button", { name: "帶入這 1 條" });
    expect((await use.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "F6", `memory-recall-375-${info.project.name}`);
    await expectAccessible(page);
    await use.tap();
    await expect(composer(page)).toHaveValue(/^之前得出過：/);
  });

  test("tags and folds by touch: 44px targets", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "neither on the core-only server");
    await narrowConversation(page, info, Q, "F6 phone");
    const row = replies(page).last();
    await expect(argBadge(row)).toHaveAttribute("data-tg-arg-badge", "draft", { timeout: 20_000 });
    // Touch (decision #8): the draft is confirmed or changed from the label row's sheet, first row; 44px targets.
    const more = row.getByRole("button", { name: "更多動作" });
    expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await more.tap();
    const sheet = page.getByRole("dialog");
    const confirm = sheet.getByRole("button", { name: "確認類型「想法」" });
    expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await sheet.getByRole("button", { name: "取消" }).tap();
    await setArgType(row, "贊成", { tap: true });
    await expect(argBadge(row)).toHaveText("贊成");
    await foldFromFirst(page, 2);
    const toggle = foldBlock(page).first().getByRole("button", { name: /^已折疊/ });
    expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await shoot(page, "F6", `fold-375-${info.project.name}`);
    await expectAccessible(page);
    await divergeFromLast(page, 2);
    const pick = marker(page, 2).getByRole("checkbox", { name: /^比較「Direction 1/ });
    expect((await pick.locator("xpath=..").boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await pick.tap();
    await expect(pick).toBeChecked();
  });
});

