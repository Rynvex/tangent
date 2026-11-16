import { expect, test, type Locator, type Page } from "@playwright/test";
import { branchBar, outlineRow, outlineTree } from "./f5-flows";
import { composer, replies, toast, turn } from "./flows";
import { expectAccessible, isApi, MODERATE, shoot } from "./helpers";

/**
 * F18 §2.1–§2.3 on the mock's NAS scenario: what becomes of an answered
 * quick question (保留, 丟掉 with its undo, 接著問), a conversation's
 * default for them, and 刪除支線 in the outline. The mock lives in the page,
 * so a reload starts it over: what must survive a reload here is only what
 * the browser keeps (the default); that the server keeps an aside is checked
 * by going away and coming back.
 */

const Q = "theme=light&lang=zh-TW";
const ASIDE = "了解：vdev";
const DISCARDED = "二手企業碟可不可靠";
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });
const message = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
const inlineAside = (page: Page) => page.getByRole("region", { name: `順口問：${ASIDE}` });
const lineInAddress = (page: Page) => new URL(page.url()).searchParams.get("line");

test.beforeEach(({}, info) => test.skip(isApi(info), "These flows run on the mock's scenario (the reference server answers with a real model)"));

/** Selects `text` inside `element` (one text node). */
async function selectIn(element: Locator, text: string): Promise<void> {
  await element.evaluate((node, wanted) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const at = current.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(current, at);
      range.setEnd(current, at + wanted.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    throw new Error(`"${wanted}" not found`);
  }, text);
}

/** 秒問解釋 on 「vdev」 of the main line: the aside opens in place and is answered. Returns its card. */
async function askedInPlace(page: Page): Promise<Locator> {
  const reply = message(page, "nas-m19");
  await reply.scrollIntoViewIfNeeded();
  await selectIn(reply, "vdev");
  await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "秒問解釋" }).click();
  const inline = inlineAside(page);
  await expect(inline).toBeVisible();
  // Answered: the footer's writes are there.
  await expect(inline.getByRole("button", { name: "丟掉" })).toBeVisible({ timeout: 20_000 });
  return inline;
}

/** Shows a line by its id without loading the page again (the mock would start over): the address, then popstate. */
async function showLine(page: Page, lineId: string): Promise<void> {
  await page.evaluate((id) => {
    const url = new URL(window.location.href);
    url.searchParams.set("line", id);
    url.searchParams.delete("m");
    window.history.pushState(window.history.state, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, lineId);
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("① 秒問解釋 → 保留: the card, the full view and the outline say 已保留, and it is still kept after going away and back", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const inline = await askedInPlace(page);
    await expect(inline.locator("[data-tg-aside-fate]")).toContainText("天後清除");
    await inline.getByRole("button", { name: "保留", exact: true }).click();
    await expect(inline.locator("[data-tg-aside-fate]")).toHaveText("已保留");
    await expect(inline.getByRole("button", { name: "取消保留" })).toHaveAttribute("aria-pressed", "true");
    await expect(outlineRow(page, ASIDE)).toHaveAccessibleName(/已保留/);
    await expectAccessible(page, MODERATE, "[data-tg-aside-inline]");
    await shoot(page, "F18b", "aside-inline-kept-1440");

    // Its own view: the wrap-up says the same, and offers to undo it.
    await inline.getByRole("button", { name: "展開完整畫面" }).first().click();
    await expect(path(page)).toContainText(ASIDE);
    const wrapUp = page.getByRole("region", { name: "回答完了，接下來？" });
    await expect(wrapUp.locator("[data-tg-aside-fate]")).toHaveText("已保留，不會被清除。");
    await expect(wrapUp.getByRole("button", { name: "取消保留" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "已回答，已保留。" })).toBeVisible();
    await expectAccessible(page, MODERATE, "[data-tg-aside-wrap-up]");
    await shoot(page, "F18b", "aside-wrap-up-kept-1440");

    // Another conversation and back: the server's copy is the kept one.
    await showLine(page, "okr");
    await expect(path(page)).not.toContainText(ASIDE);
    await page.goBack();
    await expect(path(page)).toContainText(ASIDE);
    await expect(wrapUp.locator("[data-tg-aside-fate]")).toHaveText("已保留，不會被清除。");
    await wrapUp.getByRole("button", { name: "取消保留" }).click();
    await expect(wrapUp.locator("[data-tg-aside-fate]")).toContainText("天後清除");
    await expect(wrapUp.getByRole("button", { name: "保留", exact: true })).toBeVisible();
  });

  test("①b a conversation set to 保留 (kept in this browser) keeps what 秒問解釋 asks, also after a reload", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    // The header's conversation menu (the list's rows have the same one).
    await page.getByRole("main").getByRole("button", { name: "「家用 NAS 與備份策略」的動作" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("group", { name: /順口問預設/ })).toContainText("只記在這個瀏覽器");
    await expect(menu.getByRole("menuitemradio", { name: "用完即丟" })).toHaveAttribute("aria-checked", "true");
    await shoot(page, "F18b", "aside-default-menu-1440");
    await menu.getByRole("menuitemradio", { name: "保留" }).click();
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => window.localStorage.getItem("tangent:aside-default:v1"))).toBe('["nas"]');

    await page.reload();
    await expect(replies(page).first()).toBeVisible();
    const inline = await askedInPlace(page);
    await expect(inline.locator("[data-tg-aside-fate]")).toHaveText("已保留");
    await expect(inline.getByRole("button", { name: "取消保留" })).toBeVisible();
  });

  test("② 順口問 → 丟掉 → 復原 brings it back; 丟掉 again and five seconds later it is really gone", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const inline = await askedInPlace(page);
    const asideId = await inline.getAttribute("data-tg-aside-inline");
    expect(asideId).toBeTruthy();
    await expect(outlineRow(page, ASIDE)).toBeVisible();

    await inline.getByRole("button", { name: "丟掉" }).click();
    await expect(toast(page)).toContainText("已丟掉順口問。");
    await expect(inlineAside(page)).toHaveCount(0);
    await expect(outlineRow(page, ASIDE)).toHaveCount(0);
    await shoot(page, "F18b", "aside-discard-undo-1440");
    await toast(page).getByRole("button", { name: "復原" }).click();
    await expect(toast(page)).toContainText("已復原。");
    await expect(outlineRow(page, ASIDE)).toBeVisible();
    // Still there for real: its own view opens.
    await outlineRow(page, ASIDE).click();
    await expect(path(page)).toContainText(ASIDE);
    const wrapUp = page.getByRole("region", { name: "回答完了，接下來？" });
    await expect(wrapUp).toBeVisible();

    // From its own view this time: the frame goes back to the line above at once.
    await wrapUp.getByRole("button", { name: "丟掉" }).click();
    await expect(toast(page)).toContainText("已丟掉順口問。");
    await expect(path(page)).not.toContainText(ASIDE);
    expect(lineInAddress(page)).toBe("nas");
    await expect(outlineRow(page, ASIDE)).toHaveCount(0);
    // The wait this feature is about: five seconds, then the delete is sent.
    await page.waitForTimeout(5600);
    await expect(toast(page).getByRole("button", { name: "復原" })).toHaveCount(0);
    await expect(outlineRow(page, ASIDE)).toHaveCount(0);
    // Its line is gone on the "server": asking for it lands back in this conversation.
    await showLine(page, asideId!);
    await expect.poll(() => lineInAddress(page)).toBe("nas");
    await expect(composer(page)).toBeVisible();
    await expect(path(page)).not.toContainText(ASIDE);
  });

  test("③ 順口問 → 接著問: straight into the new branch with the question and answer in it, the composer focused, and another turn goes through", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const inline = await askedInPlace(page);
    const asideId = await inline.getAttribute("data-tg-aside-inline");
    await inline.getByRole("button", { name: "接著問" }).click();

    await expect(branchBar(page)).toContainText(ASIDE);
    await expect(path(page)).toContainText(ASIDE);
    const newLine = lineInAddress(page);
    expect(newLine).not.toBe("nas");
    expect(newLine).not.toBe(asideId);
    // Never the 「已清除」 notice on the way, and no failure dialog.
    await expect(page.getByText("這則順口問已經清除")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "沒辦法接著問" })).toHaveCount(0);
    // The aside's own question and answer are here, and it is an open branch now.
    await expect(page.locator("[data-message-id]").filter({ hasText: "什麼是「vdev」？" })).toBeVisible();
    await expect(replies(page)).toHaveCount(1);
    await expect(composer(page)).toBeFocused();
    await expect(outlineRow(page, ASIDE)).toHaveCount(1);
    await expect(outlineRow(page, ASIDE)).toHaveAccessibleName(/進行中/);
    await shoot(page, "F18b", "aside-continued-1440");

    await turn(page, "那一個 vdev 可以有幾顆碟？");
    await expect(replies(page)).toHaveCount(2);
    // Back goes to the main line, not to the aside that no longer exists.
    await page.goBack();
    await expect(branchBar(page)).toHaveCount(0);
    expect(lineInAddress(page)).toBe("nas");
  });

  test("刪除支線 in the outline: the row's button hides it with an undo; Delete on the row does the same and it is gone after the wait", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const row = outlineRow(page, DISCARDED);
    await expect(row).toBeVisible();
    // Only branches that can go offer it: not the open one, not the one brought back.
    await expect(outlineRow(page, "4TB 與 8TB 硬碟的每 TB 成本與保固").locator("[data-tg-delete]")).toHaveCount(0);
    await expect(outlineRow(page, "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異").locator("[data-tg-delete]")).toHaveCount(0);

    await row.hover();
    await shoot(page, "F18b", "outline-delete-1440");
    await row.locator("[data-tg-delete]").click();
    await expect(toast(page)).toContainText(`已刪除支線「${DISCARDED}」。`);
    await expect(row).toHaveCount(0);
    // The line itself was not entered.
    expect(lineInAddress(page)).toBe("nas");
    await toast(page).getByRole("button", { name: "復原" }).click();
    await expect(row).toBeVisible();

    await row.focus();
    await page.keyboard.press("Delete");
    await expect(row).toHaveCount(0);
    await page.waitForTimeout(5600);
    await expect(row).toHaveCount(0);
    await showLine(page, "nas-b4");
    await expect.poll(() => lineInAddress(page)).toBe("nas");
    await expect(outlineTree(page)).toBeVisible();
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  /** Nothing of `locator` (nor the page) is wider than its box. */
  async function expectNoOverflow(page: Page, locator: Locator): Promise<void> {
    const box = await locator.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth, right: element.getBoundingClientRect().right }));
    expect(box.scroll).toBeLessThanOrEqual(box.client);
    expect(box.right).toBeLessThanOrEqual(375);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Every button of it is inside the screen.
    for (const button of await locator.getByRole("button").all()) {
      const rect = await button.boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(375.5);
    }
  }

  test("⑤ the wrap-up of an answered aside, and its card opened in place, do not overflow sideways", async ({ page }) => {
    // The scenario's answered aside in its own view.
    await page.goto(`/?${Q}&line=nas-b1a`);
    const wrapUp = page.getByRole("region", { name: "回答完了，接下來？" });
    await expect(wrapUp).toBeVisible();
    await wrapUp.scrollIntoViewIfNeeded();
    for (const name of ["保留", "接著問", "丟掉", "記進紀要並回上一層", "記成備忘並回上一層", "直接回上一層"]) await expect(wrapUp.getByRole("button", { name, exact: true })).toBeVisible();
    await expectNoOverflow(page, wrapUp);
    await expectAccessible(page, MODERATE, "[data-tg-aside-wrap-up]");
    await shoot(page, "F18b", "aside-wrap-up-375");

    // A quick question asked in place on the main line (a line that can still be written): its card's footer.
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    const inline = await askedInPlace(page);
    await expect(inline.getByRole("button", { name: "接著問" })).toBeVisible();
    await expect(inline.getByRole("button", { name: "保留", exact: true })).toBeVisible();
    await inline.scrollIntoViewIfNeeded();
    await expectNoOverflow(page, inline);
    await shoot(page, "F18b", "aside-inline-375");
  });
});
