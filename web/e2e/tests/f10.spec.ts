import { expect, test, type Locator, type Page } from "@playwright/test";
import { composer, replies, sidePanel, toast, turn } from "./flows";
import { expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { openTab } from "./f5-flows";

/**
 * F10 (9_F10_SIMPLE_UX.md) on the mock: a selected term prefills the first
 * question and the branch opens with it sent; 秒問解釋 asks an aside with no
 * dialog and its answer is kept from the wrap-up; memos in the normal side
 * panel with the Feynman check sent at once.
 */

const Q = "theme=light&lang=zh-TW";
const ASKED = "請介紹豪斯多夫維度與碎形的關係";
const TERM = "豪斯多夫維度";
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });

test.beforeEach(({}, info) => test.skip(isApi(info), "F10's flows run on the mock (the reference server answers with a real model)"));

/** Selects `text` inside the element that shows `within` (one text node). */
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

/** A conversation whose last user message holds the term. */
async function askedAboutTerm(page: Page): Promise<Locator> {
  await page.goto(`/?${Q}&line=okr`);
  await expect(composer(page)).toBeVisible();
  await turn(page, ASKED);
  return page.locator("[data-message-id]").filter({ hasText: ASKED }).last();
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("① a selected term: 名詞解釋 prefilled, the chips switch it, and 開啟支線並送出問題 asks it in the new branch", async ({ page }) => {
    const asked = await askedAboutTerm(page);
    await selectIn(asked, TERM);
    await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "從這段開支線" }).click();
    const dialog = page.getByRole("dialog", { name: "開支線" });
    const chips = dialog.getByRole("radiogroup", { name: "要問 AI 什麼" });
    await expect(chips.getByRole("radio")).toHaveText(["名詞解釋", "名詞用途", "核心原理", "比較與優缺點"]);
    await expect(chips.getByRole("radio", { name: "名詞解釋" })).toHaveAttribute("aria-checked", "true");
    const question = dialog.getByRole("textbox", { name: "第一句要問 AI 什麼" });
    await expect(question).toHaveValue(`什麼是「${TERM}」？請用簡單好懂的方式解釋，並舉一個例子。`);
    await expect(dialog).toContainText(`了解：${TERM}`);
    await chips.getByRole("radio", { name: "核心原理" }).click();
    await expect(question).toHaveValue(`「${TERM}」背後的運作原理或核心定義是什麼？`);
    await expect(dialog).toContainText(`原理：${TERM}`);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F10", "ask-chips-1440");
    await dialog.getByRole("button", { name: "開啟支線並送出問題" }).click();
    await expect(dialog).toBeHidden();
    await expect(path(page)).toContainText(`原理：${TERM}`);
    await expect(page.locator("[data-message-id]").filter({ hasText: "背後的運作原理或核心定義是什麼" })).toBeVisible();
    await expect(replies(page).last()).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
    await expect(composer(page)).toHaveValue("");
  });

  test("秒問解釋 asks an aside with no dialog; its wrap-up keeps the answer in the notes and goes back", async ({ page }) => {
    const asked = await askedAboutTerm(page);
    await selectIn(asked, TERM);
    await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "秒問解釋" }).click();
    await expect(page.getByRole("dialog", { name: "開支線" })).toHaveCount(0);
    // F12 S1: the aside answers in place first; 展開完整畫面 goes to its own view and wrap-up.
    const inline = page.getByRole("region", { name: `順口問：了解：${TERM}` });
    await expect(inline).toBeVisible();
    await inline.getByRole("button", { name: "展開完整畫面" }).first().click();
    await expect(path(page)).toContainText(`了解：${TERM}`);
    await expect(page.locator("[data-message-id]").filter({ hasText: `什麼是「${TERM}」？` })).toBeVisible();
    const wrapUp = page.getByRole("region", { name: "回答完了，接下來？" });
    await expect(wrapUp).toBeVisible({ timeout: 20_000 });
    await shoot(page, "F10", "aside-wrap-up-1440");
    await wrapUp.getByRole("button", { name: "記進紀要並回上一層" }).click();
    await expect(toast(page)).toHaveText("已記進紀要。");
    await expect(path(page)).not.toContainText(`了解：${TERM}`);
    await openTab(page, "紀要");
    await expect(sidePanel(page)).toContainText(`了解：${TERM}：`);
  });

  test("② memos in the normal side panel: add one, then 請 AI 檢驗理解… sends the check in a new branch", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    await openTab(page, "紀要");
    const side = sidePanel(page);
    await side.getByRole("radio", { name: /^備忘（自己的理解）/ }).click();
    await side.getByRole("button", { name: "新增備忘" }).click();
    await side.getByRole("textbox").fill("RAID1 就是兩顆碟存一樣的資料，壞一顆還能讀");
    await side.getByRole("button", { name: "儲存" }).click();
    const actions = side.getByRole("button", { name: "這則備忘的動作" }).first();
    await expect(actions).toBeVisible();
    await expect(side.getByText("RAID1 就是兩顆碟存一樣的資料，壞一顆還能讀")).toBeVisible();
    await expect(side.getByRole("radio", { name: /^備忘（自己的理解） 1/ })).toBeVisible();
    await shoot(page, "F10", "side-memos-1440");
    await actions.click();
    await page.getByRole("menuitem", { name: "請 AI 檢驗理解…" }).click();
    const dialog = page.getByRole("dialog", { name: "開支線" });
    await expect(dialog.getByRole("textbox", { name: "第一句要問 AI 什麼" })).toHaveValue(/RAID1 就是兩顆碟存一樣的資料/);
    await expect(dialog.getByRole("radiogroup", { name: "要問 AI 什麼" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "開啟支線並送出問題" }).click();
    await expect(dialog).toBeHidden();
    await expect(path(page)).toContainText("檢驗理解：");
    await expect(page.locator("[data-message-id]").filter({ hasText: "請用費曼學習法檢驗" })).toBeVisible();
    await expect(composer(page)).toHaveValue("");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("the open-branch dialog and its chips fit the screen", async ({ page }) => {
    const asked = await askedAboutTerm(page);
    await selectIn(asked, TERM);
    await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "從這段開支線" }).click();
    const dialog = page.getByRole("dialog", { name: "開支線" });
    await expect(dialog.getByRole("radio", { name: "比較與優缺點" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await shoot(page, "F10", "ask-chips-375");
  });
});
