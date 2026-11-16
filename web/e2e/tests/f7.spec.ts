import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { API, expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { apiCall, apiTurn, composer, freshConversation, replies, toast, turn } from "./flows";
import { backToMain, openBranch } from "./f5-flows";

/**
 * F7: 刪除對話 on the mock and the reference server — from a list row's menu
 * and from the header (main line only), the confirmation (what goes, the
 * branch count, never undone, 改為封存; focus on 取消, Esc cancels), the
 * refusal while a reply runs (`session_busy`), the archive section, another
 * tab's delete (`line.deleted`), viewers without the menu — at 1440, 420
 * (embedded) and 375 (phone). Every test deletes only conversations it made.
 */

// One worker runs this file in order: a page that deleted its conversation shows the newest one next, and on the shared
// server that may be another F7 test's, which that test is about to delete (the other specs never delete).
test.describe.configure({ mode: "default" });

const Q = "theme=light&lang=zh-TW";
const MOCK_TITLE = "週報的 OKR 用語";

const list = (page: Page) => page.getByRole("navigation", { name: "對話" });
const header = (page: Page) => page.locator("main > header");
const actions = (scope: Locator | Page, title: string) => scope.getByRole("button", { name: `「${title}」的動作` });
const confirmDialog = (page: Page, title: string) => page.getByRole("dialog", { name: `刪除「${title}」？` });
const unique = (label: string) => `${label} ${randomBytes(3).toString("hex")}`;

/**
 * A conversation with one reply and one branch on it, open on its main line:
 * made through the API on the server, in the UI on the mock (its "okr").
 * Returns its title and, on the server, its id.
 */
async function conversationWithBranch(page: Page, info: TestInfo, label: string, query = Q): Promise<{ title: string; id: string | null }> {
  if (!isApi(info)) {
    await freshConversation(page, info, query, 1);
    await openBranch(page, "Temple passes");
    await backToMain(page);
    return { title: MOCK_TITLE, id: null };
  }
  const title = unique(label);
  const line = await apiCall<{ id: string }>(page, "post", "/lines", { title }, info);
  await apiTurn(page, line.id, "Question 1 about the Kyoto trip", info);
  const { messages } = await apiCall<{ messages: Array<{ id: string; role: string }> }>(page, "get", `/lines/${line.id}/messages`, undefined, info);
  const reply = messages.filter((message) => message.role === "assistant").at(-1)!;
  await apiCall(page, "post", `/lines/${line.id}/branches`, { anchorMessageId: reply.id, purpose: "Temple passes", kind: "investigate" }, info);
  await page.goto(`/?${query}&line=${line.id}`);
  await expect(replies(page)).toHaveCount(1);
  return { title, id: line.id };
}

/** Opens 刪除對話… from a menu trigger; the dialog with focus on 取消. */
async function askToDelete(page: Page, trigger: Locator, title: string, tap = false): Promise<Locator> {
  await (tap ? trigger.tap() : trigger.click());
  const item = page.getByRole("menuitem", { name: "刪除對話…" });
  await (tap ? item.tap() : item.click());
  const dialog = confirmDialog(page, title);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  return dialog;
}

/** The tree is gone: on the server its main line answers 404. */
async function expectGone(page: Page, info: TestInfo, id: string | null): Promise<void> {
  if (!id) return;
  const port = info.project.name === "api-core" ? process.env.TANGENT_E2E_CORE_API_PORT : process.env.TANGENT_E2E_API_PORT;
  const check = await page.request.get(`http://127.0.0.1:${port}/api/lines/${id}`, { headers: { Authorization: `Bearer ${API.token()}` } });
  expect(check.status()).toBe(404);
}

/** Another conversation is on screen and nothing of the deleted one is broken (no load error). */
async function expectNextConversation(page: Page, title: string): Promise<void> {
  await expect(page.getByText("無法載入訊息。")).toHaveCount(0);
  // The banner's live region is always there, empty; nothing may say anything in one.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "路徑" }).or(page.getByText("選一段對話，或開始新對話。")).first()).toBeVisible();
  await expect(header(page)).not.toContainText(title);
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("from a row's menu: the confirmation says what goes, Esc cancels, 刪除對話 deletes and the next conversation shows", async ({ page }, info) => {
    // On the server, an older conversation to come next (this run's database may have no other yet).
    if (isApi(info)) await apiCall(page, "post", "/lines", { title: unique("F7 next") }, info);
    const { title, id } = await conversationWithBranch(page, info, "F7 row");
    const row = list(page).getByRole("button", { name: new RegExp(`^${title}`) }).first();
    await row.hover();
    const trigger = actions(list(page), title);
    let dialog = await askToDelete(page, trigger, title);
    await expect(dialog).toContainText("會刪掉整棵對話：主線、1 條支線（不論開著或已結束），以及其中所有訊息、紀要與章節。");
    await expect(dialog).toContainText("刪除後不能復原。");
    await expect(dialog).toContainText("只是不想在清單上看到它？改用封存，之後還能解除封存。");
    await expect(dialog.getByRole("button", { name: "改為封存" })).toBeVisible();
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F7", `confirm-1440-${info.project.name}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(actions(list(page), title)).toHaveCount(1);

    dialog = await askToDelete(page, trigger, title);
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    // The toast first: it lasts 2.8 s, and on a loaded machine the dialog's exit can take a while.
    await expect(toast(page)).toContainText(`已刪除「${title}」。`);
    await expect(dialog).toBeHidden();
    await expect(list(page).getByText(title, { exact: true })).toHaveCount(0);
    await expectNextConversation(page, title);
    // Focus moved on to the conversation now current in the list (the menu that opened the dialog is gone).
    await expect(list(page).locator('[aria-current="page"]')).toBeFocused();
    await expectGone(page, info, id);
    await expectAccessible(page);
  });

  test("from the header: only on the main line (a branch has no menu); deleting the conversation on screen leaves it", async ({ page }, info) => {
    const { title, id } = await conversationWithBranch(page, info, "F7 header");
    await expect(actions(header(page), title)).toBeVisible();
    await page.getByRole("treeitem", { name: /^Temple passes/ }).click();
    await expect(header(page)).toContainText("Temple passes");
    await expect(header(page).getByRole("button", { name: /」的動作$/ })).toHaveCount(0);
    await backToMain(page);
    const dialog = await askToDelete(page, actions(header(page), title), title);
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    await expect(toast(page)).toContainText(`已刪除「${title}」。`);
    await expectNextConversation(page, title);
    await expectGone(page, info, id);
  });

  test("a reply still running: the server refuses (session_busy) in the dialog; once it ends, the delete goes through", async ({ page }, info) => {
    test.slow();
    const { title, id } = await conversationWithBranch(page, info, "F7 busy");
    let dialog: Locator;
    if (id) {
      // On the server the slow reply (3 s) starts with the dialog already open, so a loaded machine cannot outrun it.
      dialog = await askToDelete(page, actions(header(page), title), title);
      await apiCall(page, "post", `/lines/${id}/messages`, { content: "[fake:slow] take your time" }, info);
    } else {
      await composer(page).fill("[fake:slow] take your time");
      await composer(page).press("Enter");
      await expect(replies(page).last()).toHaveAttribute("aria-busy", "true");
      dialog = await askToDelete(page, actions(header(page), title), title);
    }
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("這段對話裡還有正在回覆的回合。等它結束（或先停止）再刪除。");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F7", `busy-1440-${info.project.name}`);
    if (id) await expect.poll(async () => (await apiCall<{ status: string }>(page, "get", `/lines/${id}`, undefined, info)).status, { timeout: 20_000 }).toBe("idle");
    else await expect(replies(page).last()).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    // The toast first: it lasts 2.8 s, and on a loaded machine the dialog's exit can take a while.
    await expect(toast(page)).toContainText(`已刪除「${title}」。`);
    await expect(dialog).toBeHidden();
    await expectGone(page, info, id);
  });

  test("the archive section: an archived conversation is deleted from its row (no 改為封存 there)", async ({ page }, info) => {
    let title = "Proxmox 叢集規劃";
    let id: string | null = null;
    if (isApi(info)) {
      title = unique("F7 archived");
      id = (await apiCall<{ id: string }>(page, "post", "/lines", { title }, info)).id;
      await apiCall(page, "post", `/lines/${id}/archive`, undefined, info);
    }
    await page.goto(`/?${Q}`);
    await list(page).getByRole("button", { name: /^封存（\d+）$/ }).click();
    const row = list(page).getByRole("button", { name: new RegExp(`^${title}`) }).first();
    await row.hover();
    const dialog = await askToDelete(page, actions(list(page), title), title);
    await expect(dialog.getByRole("button", { name: "改為封存" })).toHaveCount(0);
    await expect(dialog).toContainText("它已封存；刪除後就不能再解除封存。");
    await expect(dialog).toContainText("它沒有支線。");
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    await expect(toast(page)).toContainText(`已刪除「${title}」。`);
    await expect(list(page).getByText(title, { exact: true })).toHaveCount(0);
    await expectGone(page, info, id);
  });

  test("改為封存 from the dialog archives instead", async ({ page }, info) => {
    const { title } = await conversationWithBranch(page, info, "F7 archive instead");
    const dialog = await askToDelete(page, actions(header(page), title), title);
    await dialog.getByRole("button", { name: "改為封存" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("這段對話已封存。")).toBeVisible();
  });

  test("another tab deletes the conversation on screen (line.deleted): this one leaves it and says so", async ({ page, context }, info) => {
    test.skip(!isApi(info), "the mock lives in one page; the server shares the tree between tabs");
    const { title, id } = await conversationWithBranch(page, info, "F7 elsewhere");
    const other = await context.newPage();
    await other.goto(`/?${Q}&line=${id}`);
    await expect(replies(other)).toHaveCount(1);
    const dialog = await askToDelete(other, actions(header(other), title), title);
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    await expect(toast(other)).toContainText(`已刪除「${title}」。`);
    await expect(toast(page)).toContainText("你正在看的對話已被刪除（在別的分頁或裝置上）。");
    await expect(list(page).getByText(title, { exact: true })).toHaveCount(0);
    await expectNextConversation(page, title);
    await other.close();
  });

  test("viewers have no menu: neither on the rows nor in the header", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "the same on both servers; once is enough");
    await page.goto(`/?${Q}&as=viewer`);
    await expect(list(page).getByRole("button").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /」的動作$/ })).toHaveCount(0);
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the header's menu and the dialog fit the frame; deleting shows the next conversation", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "the same frame on both servers");
    const { title, id } = await conversationWithBranch(page, info, "F7 embed", "frame=embed&lang=zh-TW");
    const dialog = await askToDelete(page, actions(header(page), title), title);
    const box = await dialog.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
    await shoot(page, "F7", `confirm-420-${info.project.name}`);
    await expectAccessible(page);
    await dialog.getByRole("button", { name: "刪除對話" }).click();
    await expect(dialog).toBeHidden();
    await expectNextConversation(page, title);
    await expectGone(page, info, id);
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("by touch from the list drawer: 44px targets, the dialog full screen, then the next conversation", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "the same frame on both servers");
    const { title, id } = await conversationWithBranch(page, info, "F7 phone");
    await page.getByRole("button", { name: "展開對話清單" }).tap();
    const trigger = actions(list(page), title);
    await expect(trigger).toBeVisible();
    expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const dialog = await askToDelete(page, trigger, title, true);
    const remove = dialog.getByRole("button", { name: "刪除對話" });
    expect((await remove.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "F7", `confirm-375-${info.project.name}`);
    await expectAccessible(page);
    await remove.tap();
    // The toast first: it lasts 2.8 s, and on a loaded machine the dialog's exit can take a while.
    await expect(toast(page)).toContainText(`已刪除「${title}」。`);
    await expect(dialog).toBeHidden();
    await expect(list(page).getByText(title, { exact: true })).toHaveCount(0);
    await expectGone(page, info, id);
    await expectAccessible(page);
  });

  test("the header's menu on the phone", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "the same frame on both servers");
    const { title } = await conversationWithBranch(page, info, "F7 phone header");
    if (!isApi(info)) await turn(page, "再一題");
    const trigger = actions(header(page), title);
    expect((await trigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const dialog = await askToDelete(page, trigger, title, true);
    await dialog.getByRole("button", { name: "刪除對話" }).tap();
    await expect(toast(page)).toContainText(`已刪除「${title}」。`);
    await expectNextConversation(page, title);
  });
});

/**
 * B7.2 follow-ups (with F7): a host's system messages after a reply. Mock
 * only: the server's fake runner has no host, so `[fake:notice]` (a notice
 * right after the pending reply) exists in the mock alone.
 */
test.describe("1440 desktop: a host's notices (B7.2)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(isApi(info), "the reference server has no host writing notices"));

  test("a failed reply followed by a notice keeps 重試; a notice during a streaming reply sits after it", async ({ page }, info) => {
    await freshConversation(page, info, Q, 1);
    const notice = page.getByText("Host notice (fake runner)");
    await composer(page).fill("[fake:error] [fake:notice] 這次會失敗");
    await composer(page).press("Enter");
    await expect(notice).toHaveCount(1);
    const failed = replies(page).last();
    await expect(failed.getByRole("button", { name: "重試" })).toBeVisible({ timeout: 20_000 });
    await expectAccessible(page, MODERATE, "main");
    await failed.getByRole("button", { name: "重試" }).click();
    await expect(notice).toHaveCount(2);

    await freshConversation(page, info, Q, 1);
    await composer(page).fill("[fake:slow] [fake:notice] 慢慢來");
    await composer(page).press("Enter");
    const streaming = replies(page).last();
    await expect(streaming).toHaveAttribute("aria-busy", "true");
    await expect(notice).toBeVisible();
    // By seq: the reply still streaming, then the notice under it.
    const lastTwo = () => page.locator("[data-tg-row]").evaluateAll((rows) => rows.slice(-2).map((row) => (row.querySelector("article[data-tg-message]") ? "reply" : row.textContent)));
    expect(await lastTwo()).toEqual(["reply", "Host notice (fake runner)"]);
    // The reply finishes in place, before the notice.
    await expect(streaming).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
    await expect(streaming).not.toBeEmpty();
    expect(await lastTwo()).toEqual(["reply", "Host notice (fake runner)"]);
  });
});
