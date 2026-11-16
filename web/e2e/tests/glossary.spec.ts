import { expect, test, type Locator, type Page } from "@playwright/test";
import { openTab } from "./f5-flows";
import { composer, replies, sidePanel, toast, turn } from "./flows";
import { expectAccessible, isApi, messageAction, MODERATE, shoot } from "./helpers";

/**
 * F19 on the mock's NAS scenario: the glossary. 秒問解釋 → 存進名詞表 → the
 * side panel's 名詞表 → the term underlined in a later reply, with its
 * explanation on hover; a term already there is overwritten; another
 * conversation says 「之前問過」; with the feature off nothing of it shows;
 * and the same on a phone. The mock lives in the page, so every test builds
 * what it needs through the UI.
 */

const Q = "theme=light&lang=zh-TW";
const TERM = "ZFS";
const ASIDE = `了解：${TERM}`;
const message = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
const inlineAside = (page: Page) => page.getByRole("region", { name: `順口問：${ASIDE}` });
const saveDialog = (page: Page) => page.getByRole("dialog", { name: "存進名詞表" });
const glossary = (page: Page) => sidePanel(page).getByRole("region", { name: "名詞表" });
const termMarks = (page: Page) => page.locator("[data-tg-term-mark]");
const selectionToolbar = (page: Page) => page.getByRole("toolbar", { name: "選取的文字" });

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

/** 秒問解釋 on 「ZFS」 of the main line: the aside opens in place and is answered. Returns its card. */
async function askedInPlace(page: Page): Promise<Locator> {
  const reply = message(page, "nas-m19");
  await reply.scrollIntoViewIfNeeded();
  await selectIn(reply, TERM);
  await selectionToolbar(page).getByRole("button", { name: "秒問解釋" }).click();
  const inline = inlineAside(page);
  await expect(inline).toBeVisible();
  await expect(inline.getByRole("button", { name: "丟掉" })).toBeVisible({ timeout: 20_000 });
  return inline;
}

/** 秒問解釋 → the card's 存進名詞表 → the dialog as it opens (prefilled). */
async function openSaveFromAside(page: Page, { tap = false }: { tap?: boolean } = {}): Promise<{ inline: Locator; dialog: Locator }> {
  const inline = await askedInPlace(page);
  const save = inline.getByRole("button", { name: "存進名詞表" });
  await (tap ? save.tap() : save.click());
  const dialog = saveDialog(page);
  await expect(dialog.getByRole("textbox", { name: "名詞" })).toHaveValue(TERM);
  return { inline, dialog };
}

/** The whole save: the term is in the glossary with `explanation`. */
async function savedFromAside(page: Page, explanation: string, options: { tap?: boolean } = {}): Promise<Locator> {
  const { inline, dialog } = await openSaveFromAside(page, options);
  await dialog.getByRole("textbox", { name: "解釋" }).fill(explanation);
  const button = dialog.getByRole("button", { name: "存進名詞表" });
  await (options.tap ? button.tap() : button.click());
  await expect(dialog).toBeHidden();
  await expect(toast(page)).toContainText("已存進名詞表。");
  return inline;
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("① 秒問解釋 → 存進名詞表 → the side panel lists it → a later reply underlines it → hovering shows the explanation", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    // Nothing is underlined before there is a term.
    await expect(termMarks(page)).toHaveCount(0);

    // The card's 存進名詞表: the words that were asked about, and the start of the answer.
    const { inline, dialog } = await openSaveFromAside(page);
    const answer = await dialog.getByRole("textbox", { name: "解釋" }).inputValue();
    expect(answer.trim().length).toBeGreaterThan(10);
    await expect(dialog).toContainText("只帶名詞，不帶解釋");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F19", "save-term-dialog-1440");
    await dialog.getByRole("textbox", { name: "解釋" }).fill("一種寫入時複製的檔案系統：有校驗、快照與自我修復。");
    await dialog.getByRole("button", { name: "存進名詞表" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page)).toContainText("已存進名詞表。");

    // Saving it kept the aside, and the card says both.
    await expect(inline.getByRole("button", { name: "已存進名詞表" })).toHaveAttribute("aria-pressed", "true");
    await expect(inline.locator("[data-tg-aside-fate]")).toHaveText("已保留");
    await inline.scrollIntoViewIfNeeded();
    await expectAccessible(page, MODERATE, "[data-tg-aside-inline]");
    await shoot(page, "F19", "aside-card-footer-1440");

    // 查看 in the toast: the side panel's 名詞表, open at the term.
    await toast(page).getByRole("button", { name: "查看" }).click();
    const kinds = sidePanel(page).getByRole("radiogroup", { name: "紀要、名詞表或備忘" });
    await expect(kinds.getByRole("radio")).toHaveText([/^紀要/, "名詞表 1", /^備忘/]);
    await expect(kinds.getByRole("radio", { name: "名詞表 1" })).toHaveAttribute("aria-checked", "true");
    const list = glossary(page);
    const row = list.getByRole("listitem").filter({ hasText: TERM });
    await expect(row.getByRole("button", { name: new RegExp(`^${TERM}`) })).toHaveAttribute("aria-expanded", "true");
    await expect(row).toContainText("一種寫入時複製的檔案系統");
    await expect(row.getByRole("button", { name: /^前往「ZFS」的來源：順口問・了解：ZFS$/ })).toBeVisible();
    await expectAccessible(page, MODERATE, 'aside[aria-label="側欄"]');
    await shoot(page, "F19", "glossary-panel-1440");

    // A later reply that uses the word: underlined once, with the explanation on hover.
    await turn(page, "那斷電怎麼辦？");
    const latest = replies(page).last();
    await expect(latest).toContainText(TERM);
    const mark = latest.locator("[data-tg-term-mark]");
    await expect(mark).toHaveCount(1);
    await expect(mark).toHaveText(TERM);
    await expect(mark).toHaveCSS("text-decoration-line", "underline");
    await mark.scrollIntoViewIfNeeded();
    await mark.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("一種寫入時複製的檔案系統");
    await expect(tip).toContainText("點一下在名詞表查看");
    await shoot(page, "F19", "term-underline-1440");
    // Each reply marks a term once; code is left alone.
    const perReply = await page.evaluate(() => {
      const counts = new Map<string, number>();
      for (const item of document.querySelectorAll("[data-tg-term-mark]")) {
        const id = item.closest("[data-message-id]")?.getAttribute("data-message-id") ?? "";
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return { most: Math.max(...counts.values()), inCode: document.querySelectorAll("pre [data-tg-term-mark], code [data-tg-term-mark]").length };
    });
    expect(perReply).toEqual({ most: 1, inCode: 0 });

    // A press on the term shows it in the glossary again (from another part of the side panel).
    await openTab(page, "結構");
    await mark.click();
    await expect(glossary(page).getByRole("button", { name: new RegExp(`^${TERM}`) })).toHaveAttribute("aria-expanded", "true");
  });

  test("② a term that is already there: the dialog shows the stored explanation; 覆寫 replaces it, and a delete can be undone", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    await savedFromAside(page, "第一次的解釋。");

    // The same term again, in another spelling, from a reply's 「⋯」.
    const reply = message(page, "nas-m17");
    await reply.scrollIntoViewIfNeeded();
    await messageAction(reply, "存進名詞表");
    const dialog = saveDialog(page);
    await expect(dialog.getByRole("textbox", { name: "名詞" })).toHaveValue("");
    await dialog.getByRole("textbox", { name: "名詞" }).fill("z f s");
    await dialog.getByRole("textbox", { name: "解釋" }).fill("第二次的解釋：覆寫後的內容。");
    await dialog.getByRole("button", { name: "存進名詞表" }).click();
    const conflict = dialog.locator("[data-tg-term-conflict]");
    await expect(conflict).toContainText("這篇對話的名詞表已經有「ZFS」。");
    await expect(conflict).toContainText("第一次的解釋。");
    await expect(dialog.getByRole("button", { name: "存進名詞表" })).toHaveCount(0);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F19", "save-term-exists-1440");
    await dialog.getByRole("button", { name: "覆寫" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page)).toContainText("已覆寫名詞表裡的解釋。");

    // Still one term, with the new explanation and the new source.
    await toast(page).getByRole("button", { name: "查看" }).click();
    const list = glossary(page);
    await expect(list.getByRole("listitem")).toHaveCount(1);
    const row = list.getByRole("listitem").first();
    await expect(row).toContainText("第二次的解釋：覆寫後的內容。");
    await expect(row.getByRole("button", { name: /^前往「ZFS」的來源：主線 #\d+$/ })).toBeVisible();

    // 刪除 waits for its undo.
    await row.getByRole("button", { name: "刪除「ZFS」" }).click();
    await expect(sidePanel(page).locator("[data-tg-glossary-empty]")).toBeVisible();
    await expect(toast(page)).toContainText("已從名詞表刪除「ZFS」。");
    await toast(page).getByRole("button", { name: "復原" }).click();
    await expect(toast(page)).toContainText("已復原。");
    await expect(glossary(page).getByRole("listitem")).toHaveCount(1);
    await page.waitForTimeout(5600);
    await expect(glossary(page).getByRole("listitem")).toHaveCount(1);
    await expect(sidePanel(page).getByRole("radio", { name: "名詞表 1" })).toBeVisible();
  });

  test("③ another conversation: selecting the same word says 之前問過, shows what was said then, and copies it over", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    await savedFromAside(page, "一種寫入時複製的檔案系統。");

    // A new conversation that mentions the word.
    await page.getByRole("button", { name: "新對話" }).first().click();
    await expect(composer(page)).toBeVisible();
    await expect(replies(page)).toHaveCount(0);
    await turn(page, "ZFS 跟 ext4 差在哪？");
    const mine = page.locator('li[data-message-id][data-forkable="true"]').first();
    await expect(mine).toContainText("ZFS 跟 ext4 差在哪？");
    await selectIn(mine, TERM);
    const toolbar = selectionToolbar(page);
    // 秒問解釋 is there at once; the hint comes when the lookup answers.
    await expect(toolbar.getByRole("button", { name: "秒問解釋" })).toBeVisible();
    const chip = toolbar.getByRole("button", { name: "之前問過：家用 NAS 與備份策略" });
    await expect(chip).toBeVisible();
    await shoot(page, "F19", "asked-before-1440");
    await chip.click();
    const dialog = page.getByRole("dialog", { name: "之前問過「ZFS」" });
    await expect(dialog).toContainText("在「家用 NAS 與備份策略」");
    await expect(dialog).toContainText("一種寫入時複製的檔案系統。");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F19", "asked-before-dialog-1440");
    await dialog.getByRole("button", { name: "複製到這篇的名詞表" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page)).toContainText("已複製到這篇的名詞表。");

    // This conversation has it now: its own glossary lists it, and the hint does not come back for it.
    await openTab(page, "紀要");
    await sidePanel(page).getByRole("radio", { name: "名詞表 1" }).click();
    await expect(glossary(page).getByRole("listitem")).toContainText("ZFS");
    // 之前問過 still names the other conversation (it is still "before"), and this one's own term stays out of it.
    await selectIn(mine, TERM);
    await expect(selectionToolbar(page).getByRole("button", { name: "之前問過：家用 NAS 與備份策略" })).toBeVisible();
  });

  test("④ with the glossary off there is no way in and nothing of it on screen", async ({ page }) => {
    // The C1 set: notes, chapters, asides, summaries, card drafts; no glossary.
    await page.goto(`/?${Q}&features=c1&line=nas`);
    await expect(replies(page).first()).toBeVisible();

    // The side panel: 紀要 alone, no switch.
    await openTab(page, "紀要");
    await expect(sidePanel(page).getByRole("radiogroup")).toHaveCount(0);
    await expect(sidePanel(page).getByText("名詞表")).toHaveCount(0);

    // The selection toolbar and a reply's menu.
    const reply = message(page, "nas-m19");
    await reply.scrollIntoViewIfNeeded();
    await selectIn(reply, TERM);
    const toolbar = selectionToolbar(page);
    await expect(toolbar.getByRole("button", { name: "秒問解釋" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "存進名詞表" })).toHaveCount(0);
    await page.waitForTimeout(600);
    await expect(toolbar.getByRole("button", { name: /^之前問過/ })).toHaveCount(0);

    // An answered aside's card: 保留, 接著問, 丟掉 and the menu; no 存進名詞表.
    const inline = await askedInPlace(page);
    await expect(inline.getByRole("button", { name: "接著問" })).toBeVisible();
    await expect(inline.getByRole("button", { name: /名詞表/ })).toHaveCount(0);
    await inline.getByRole("button", { name: "這則順口問的其他動作" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["記進紀要", "展開完整畫面", "收合"]);
    await page.keyboard.press("Escape");

    const other = message(page, "nas-m17");
    await other.scrollIntoViewIfNeeded();
    await other.locator("[data-tg-message]").hover();
    await other.getByRole("button", { name: "更多動作" }).first().click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "存進名詞表" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(termMarks(page)).toHaveCount(0);
  });

  test("⑤ 追加 B: an archived conversation's outline offers no 刪除支線; two throw-aways share one 復原", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();

    // Two asides thrown away within the wait: one toast counts both, and its 復原 brings both back.
    const first = await askedInPlace(page);
    await first.getByRole("button", { name: "丟掉" }).click();
    await expect(toast(page)).toContainText("已丟掉順口問。");
    const reply = message(page, "nas-m19");
    await reply.scrollIntoViewIfNeeded();
    await selectIn(reply, "Btrfs");
    await selectionToolbar(page).getByRole("button", { name: "秒問解釋" }).click();
    const second = page.getByRole("region", { name: "順口問：了解：Btrfs" });
    await expect(second.getByRole("button", { name: "丟掉" })).toBeVisible({ timeout: 20_000 });
    // The first one's five seconds may be over by now (the second answer takes its time): then the toast speaks for one.
    await second.getByRole("button", { name: "丟掉" }).click();
    const said = (await toast(page).textContent()) ?? "";
    expect(said).toMatch(/已丟掉( 2 則)?順口問。/);
    await toast(page).getByRole("button", { name: "復原" }).click();
    await expect(toast(page)).toContainText(said.includes("2 則") ? "已復原 2 則。" : "已復原。");

    // Archived: the outline's rows have no delete.
    await openTab(page, "結構");
    const tree = sidePanel(page).getByRole("tree", { name: "支線大綱" });
    // The rows' delete buttons (shown on hover; a discarded branch and the scenario's answered aside have one).
    await expect(tree.locator("[data-tg-delete]").first()).toBeAttached();
    await page.getByRole("main").getByRole("button", { name: "「家用 NAS 與備份策略」的動作" }).click();
    await page.getByRole("menuitem", { name: "封存對話" }).click();
    await expect(page.getByText("這段對話已封存。")).toBeVisible();
    await expect(tree.locator("[data-tg-delete]")).toHaveCount(0);
    // Delete on a row that could be deleted before does nothing either.
    await tree.getByRole("treeitem", { name: /^二手企業碟可不可靠/ }).focus();
    await page.keyboard.press("Delete");
    await expect(tree.getByRole("treeitem", { name: /^二手企業碟可不可靠/ })).toBeVisible();
    await expect(toast(page)).not.toContainText("已刪除支線");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  /** Nothing of `locator` (nor the page) is wider than the screen. */
  async function expectNoOverflow(page: Page, locator: Locator): Promise<void> {
    const box = await locator.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth, right: element.getBoundingClientRect().right }));
    expect(box.scroll).toBeLessThanOrEqual(box.client);
    expect(box.right).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }

  test("⑥ the card's footer fits in two rows at most; saving, the side sheet's 名詞表 and a tapped term's sheet all fit the screen", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();

    // The card's footer: four actions and 「⋯」 (it was seven buttons on three rows).
    const inline = await askedInPlace(page);
    await inline.scrollIntoViewIfNeeded();
    const footer = inline.locator("footer");
    await expect(footer.getByRole("button")).toHaveCount(5);
    const rows = await footer.getByRole("button").evaluateAll((buttons) => new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size);
    expect(rows).toBeLessThanOrEqual(2);
    await expectNoOverflow(page, inline);
    await shoot(page, "F19", "aside-card-footer-375");

    // 存進名詞表: the dialog fills the screen.
    await footer.getByRole("button", { name: "存進名詞表" }).tap();
    const dialog = saveDialog(page);
    await expect(dialog.getByRole("textbox", { name: "名詞" })).toHaveValue(TERM);
    await dialog.getByRole("textbox", { name: "解釋" }).fill("一種寫入時複製的檔案系統：有校驗、快照與自我修復。");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F19", "save-term-dialog-375");
    await dialog.getByRole("button", { name: "存進名詞表" }).tap();
    await expect(dialog).toBeHidden();
    await expect(toast(page)).toContainText("已存進名詞表。");

    // 查看: the side panel (a sheet here), on 名詞表.
    await toast(page).getByRole("button", { name: "查看" }).tap();
    const list = glossary(page);
    await expect(list.getByRole("listitem")).toContainText("一種寫入時複製的檔案系統");
    await expectNoOverflow(page, list);
    await shoot(page, "F19", "glossary-panel-375");
    await page.keyboard.press("Escape");
    await expect(sidePanel(page)).toBeHidden();

    // A later reply: the term is underlined; a tap opens a bottom sheet with its explanation.
    await turn(page, "那斷電怎麼辦？");
    const mark = replies(page).last().locator("[data-tg-term-mark]");
    await expect(mark).toHaveCount(1);
    await mark.scrollIntoViewIfNeeded();
    await mark.tap();
    const sheet = page.locator("[data-tg-term-sheet]");
    await expect(sheet).toContainText("一種寫入時複製的檔案系統");
    await expect(sheet.getByRole("button", { name: "在名詞表查看" })).toBeVisible();
    await expectNoOverflow(page, sheet);
    await shoot(page, "F19", "term-sheet-375");
    await sheet.getByRole("button", { name: "關閉" }).tap();
    await expect(sheet).toBeHidden();
  });

  test("⑦ 之前問過 on a phone: the hint sits under the toolbar's buttons and stays on the screen", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    await savedFromAside(page, "一種寫入時複製的檔案系統。", { tap: true });

    // Another conversation of the scenario, shown without loading the page again (the mock would start over).
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("line", "okr");
      window.history.pushState(window.history.state, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole("region", { name: `順口問：${ASIDE}` })).toHaveCount(0);
    await turn(page, "ZFS 跟 ext4 差在哪？");
    const mine = page.locator('li[data-message-id][data-forkable="true"]').filter({ hasText: "ZFS 跟 ext4 差在哪？" }).first();
    await mine.scrollIntoViewIfNeeded();
    await selectIn(mine, TERM);
    const toolbar = selectionToolbar(page);
    const chip = toolbar.getByRole("button", { name: "之前問過：家用 NAS 與備份策略" });
    await expect(chip).toBeVisible();
    await expectNoOverflow(page, toolbar);
    const box = await chip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375.5);
    await shoot(page, "F19", "asked-before-375");
    await chip.tap();
    const dialog = page.getByRole("dialog", { name: "之前問過「ZFS」" });
    await expect(dialog).toContainText("一種寫入時複製的檔案系統。");
    await expect(dialog.getByRole("button", { name: "複製到這篇的名詞表" })).toBeVisible();
  });
});
