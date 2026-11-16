import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { expectAccessible, isApi, MODERATE, shoot, messageAction } from "./helpers";
import { apiCall, composer, freshConversation, replies, sidePanel, toast, turn } from "./flows";

/**
 * F4 phase 1 (B8 phase A) on the mock and the reference server (fake runner,
 * `TANGENT_FEATURES=…,suggestion_probe`): leaves (brought back → a conclusion,
 * not brought back → a dead end with its reason, edited and confirmed, an AI
 * draft confirmed), parking from the three entries (composer button and ⌘⇧S,
 * a message's action, the selection toolbar), a seed expanded, noted and
 * dropped, the 待處理 count, the suggestion inbox (accept, dismiss), and every
 * entry gone with the features off — at 1440, 420 (embedded) and 375 (phone).
 */

const branchBar = (page: Page) => page.getByRole("region", { name: "支線資訊" });
const leafRegion = (page: Page) => branchBar(page).getByRole("region", { name: "這條支線的收尾" });
const inboxTab = (page: Page) => sidePanel(page).getByRole("tab", { name: /^待處理/ });
const region = (page: Page, name: string): Locator => sidePanel(page).getByRole("region", { name: new RegExp(`^${name}`) });
const seedCard = (page: Page, text: string) => region(page, "停車場").getByRole("article", { name: `種子：${text}` });

async function expectInboxCount(page: Page, count: number): Promise<void> {
  await expect(inboxTab(page)).toHaveAccessibleName(new RegExp(`${count} 項待處理$`));
}

async function openTab(page: Page, name: "結構" | "紀要" | "待處理"): Promise<void> {
  await sidePanel(page).getByRole("tab", { name: new RegExp(`^${name}`) }).click();
}

/** Opens a branch from the last reply through its message action. */
async function openBranch(page: Page, purpose: string): Promise<void> {
  const from = replies(page).last();
  await from.hover();
  await messageAction(from, "從這則開支線");
  const dialog = page.getByRole("dialog", { name: "開支線" });
  await dialog.getByRole("textbox", { name: /目的/ }).fill(purpose);
  await dialog.getByRole("radio", { name: /查證/ }).click();
  await dialog.getByRole("button", { name: "開支線" }).click();
  await expect(dialog).toBeHidden();
  await expect(branchBar(page)).toContainText(purpose);
}

async function discard(page: Page, reason: string): Promise<void> {
  await branchBar(page).getByRole("button", { name: "不帶回" }).click();
  const dialog = page.getByRole("dialog", { name: "結束支線，不帶回" });
  await expect(dialog.getByText("會成為這條支線的「死路」收尾")).toBeVisible();
  if (reason) await dialog.getByRole("textbox", { name: "原因（選填）" }).fill(reason);
  await expectAccessible(page, MODERATE, '[role="dialog"]');
  await dialog.getByRole("button", { name: "結束，不帶回" }).click();
  await expect(dialog).toBeHidden();
}

async function selectInLastReply(page: Page): Promise<string> {
  const paragraph = replies(page).last().locator("p").first();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  return (await paragraph.innerText()).replace(/\s+/g, " ").trim();
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has none of these features"));

  test("leaves: a brought-back branch leaves its conclusion, a discarded one its dead end, edited and confirmed", async ({ page }, info) => {
    // A dozen turns against the real server: near 30 s when the whole suite runs on 8 workers (F5: seen at 29–31 s).
    test.slow();
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 leaves");
    await openBranch(page, "Rail passes for Kansai");
    await turn(page, "Which pass covers Nara?");
    await branchBar(page).getByRole("button", { name: "結束並帶回" }).click();
    const review = page.getByRole("dialog", { name: "結論卡" });
    // F10 §4.1: brought back straight from the prefilled card, no AI draft.
    await expect(review.getByRole("textbox", { name: /結論/ })).not.toHaveValue("");
    await review.getByRole("button", { name: "全部接受並帶回" }).click();
    await expect(review).toBeHidden();
    // The card's title row is the branch's leaf (handoff §9-4).
    const card = page.getByRole("region", { name: "結論卡" }).last();
    await expect(card.locator('[data-tg-leaf="conclusion"]')).toBeVisible();
    await openTab(page, "結構");
    await expect(sidePanel(page).getByRole("treeitem", { name: /^Rail passes for Kansai,.*結論：/ })).toBeVisible();

    // Not brought back: the reason becomes the dead end.
    await openBranch(page, "Used hard drives");
    await turn(page, "Are used enterprise drives OK?");
    await discard(page, "通電時數太高，\n保固只有 7 天");
    await expect(leafRegion(page)).toContainText("死路");
    await expect(leafRegion(page)).toContainText("通電時數太高， 保固只有 7 天");
    await expect(sidePanel(page).getByRole("treeitem", { name: /^Used hard drives,.*死路：通電時數太高/ })).toBeVisible();

    // Edit and confirm: another kind and line.
    await leafRegion(page).getByRole("button", { name: "修改" }).click();
    const form = leafRegion(page).getByRole("group", { name: "修改收尾" });
    await form.getByRole("radio", { name: "待續" }).click();
    const line = form.getByRole("textbox", { name: /一句話/ });
    await line.fill("等二手價再降一點再看");
    await expectAccessible(page, MODERATE, '[aria-label="支線資訊"]');
    await line.press("Enter");
    await expect(form).toBeHidden();
    await expect(leafRegion(page)).toContainText("待續");
    await expect(leafRegion(page)).toContainText("等二手價再降一點再看");
    await expect(sidePanel(page).getByRole("treeitem", { name: /^Used hard drives,.*待續：等二手價/ })).toBeVisible();
    await shoot(page, "F4", `leaf-1440-${info.project.name}`);
    if (!isApi(info)) return;
    // Reloaded from the server (the page opens on the main line again): the outline and the branch keep the edit.
    await page.reload();
    const row = sidePanel(page).getByRole("treeitem", { name: /^Used hard drives,.*待續：等二手價/ });
    await row.click();
    await expect(leafRegion(page)).toContainText("等二手價再降一點再看");
  });

  test("leaves: without a reason, suggest mode drafts one; it is dashed until confirmed", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 leaf draft");
    await openBranch(page, "Is a UPS needed");
    await turn(page, "Do I need a UPS for a NAS?");
    await discard(page, "");
    await expect(leafRegion(page).getByText("AI 草稿・待你確認")).toBeVisible({ timeout: 30_000 });
    await expect(leafRegion(page).locator('[data-leaf-state="draft"]')).toBeVisible();
    await shoot(page, "F4", `leaf-draft-1440-${info.project.name}`);
    await leafRegion(page).getByRole("button", { name: "確認" }).click();
    await expect(leafRegion(page).getByText("AI 草稿・待你確認")).toHaveCount(0);
    await expect(leafRegion(page).locator('[data-leaf-state="confirmed"]')).toBeVisible();
  });

  test("parking: composer button, ⌘⇧S, a message's action and a selection; then expand, note and drop", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 2, "F4 parking");
    await expectInboxCount(page, 0);

    await composer(page).fill("UPS 要不要買？");
    await composer(page).locator("xpath=..").getByRole("button", { name: "停車" }).click();
    await expect(toast(page)).toHaveText("已停車・不花 token");
    await expect(composer(page)).toHaveValue("");
    await expectInboxCount(page, 1);

    await composer(page).fill("異地備份多久同步一次？");
    await composer(page).press("ControlOrMeta+Shift+S");
    await expect(composer(page)).toHaveValue("");
    await expectInboxCount(page, 2);

    const first = replies(page).first();
    await first.hover();
    await first.getByRole("button", { name: "停車" }).click();
    await expectInboxCount(page, 3);

    const selected = await selectInLastReply(page);
    await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "停車" }).click();
    await expectInboxCount(page, 4);

    await openTab(page, "待處理");
    await expect(region(page, "停車場").getByRole("article")).toHaveCount(4);
    await expect(region(page, "停車場").getByRole("heading")).toContainText("4・不花 token");
    await expect(seedCard(page, "UPS 要不要買？").getByRole("button", { name: /^到來源：主線 #4/ })).toBeVisible();
    // The mock's replies are all the same text, so the reply's and the selection's seeds may share a name.
    await expect(seedCard(page, selected).first()).toBeVisible();
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
    await shoot(page, "F4", `parking-1440-${info.project.name}`);

    // Save one to the notes (待確認), drop one.
    await seedCard(page, "UPS 要不要買？").getByRole("button", { name: "記進紀要" }).click();
    await expect(seedCard(page, "UPS 要不要買？")).toContainText("已記進紀要的「待確認」");
    await seedCard(page, selected).first().getByRole("button", { name: `丟掉「${selected}」` }).click();
    await expect(region(page, "停車場").getByRole("article").filter({ hasText: "已丟掉" })).toHaveCount(1);
    await expectInboxCount(page, 2);

    // Expand one: the branch dialog starts from the seed (F10: its text is the first question), the seed becomes the branch.
    await seedCard(page, "異地備份多久同步一次？").getByRole("button", { name: "展開成支線" }).click();
    const dialog = page.getByRole("dialog", { name: "開支線" });
    await expect(dialog).toContainText("從停車場展開");
    await expect(dialog.getByRole("textbox", { name: "第一句要問 AI 什麼" })).toHaveValue("異地備份多久同步一次？");
    await expect(dialog).toContainText("目的異地備份多久同步一次？");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "只開支線，稍後再問" }).click();
    await expect(dialog).toBeHidden();
    await expect(branchBar(page)).toContainText("異地備份多久同步一次？");
    await expect(seedCard(page, "異地備份多久同步一次？")).toContainText("已展開成支線");
    await expectInboxCount(page, 1);

    await openTab(page, "紀要");
    await expect(sidePanel(page).getByRole("region", { name: /^待確認/ }).getByText("UPS 要不要買？", { exact: true })).toBeVisible();
  });

  test("the suggestion inbox: a probe suggestion is accepted, another dismissed", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 suggestions");
    await expectInboxCount(page, 0);
    await turn(page, "[probe:suggest] please");
    await expectInboxCount(page, 1);
    await openTab(page, "待處理");
    const suggestions = region(page, "建議");
    const card = suggestions.getByRole("article", { name: "建議：測試建議" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("關於：主線");
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
    await shoot(page, "F4", `suggestions-1440-${info.project.name}`);
    await card.getByRole("button", { name: "接受" }).click();
    await expect(card).toContainText("已接受");
    await expectInboxCount(page, 0);

    await turn(page, "[probe:suggest-permanent] again");
    await expectInboxCount(page, 1);
    const permanent = suggestions.getByRole("article", { name: /^建議：測試建議（/ });
    await permanent.getByRole("button", { name: "忽略" }).click();
    await expect(permanent).toContainText("已忽略");
    await expectInboxCount(page, 0);
  });
});

/** The mock switches its features with `?features=`; `api-core` is a server with none. */
async function openWithout(page: Page, info: TestInfo): Promise<void> {
  if (info.project.name === "mock") {
    await page.goto("/?theme=light&lang=zh-TW&features=c1&line=nas");
    await expect(replies(page).last()).toBeVisible();
    return;
  }
  const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "F4 off" }, info);
  await apiCall(page, "post", `/lines/${line.id}/messages`, { content: "Hello" }, info);
  await page.goto(`/?theme=light&lang=zh-TW&line=${line.id}`);
  await expect(replies(page)).toHaveCount(1);
}

test.describe("1440, features off", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("parking, leaves and the inbox render nothing", async ({ page }, info) => {
    test.skip(info.project.name === "api", "the api server runs them on; api-core and the mock's C1 set do not");
    await openWithout(page, info);
    await expect(inboxTab(page)).toHaveCount(0);
    const last = replies(page).last();
    await last.hover();
    await expect(last.getByRole("button", { name: "停車" })).toHaveCount(0);
    await expect(composer(page).locator("xpath=..").getByRole("button", { name: "停車" })).toHaveCount(0);
    await composer(page).fill("not parked");
    await composer(page).press("ControlOrMeta+Shift+S");
    await expect(composer(page)).toHaveValue("not parked");
    await expect(page.locator("[data-tg-leaf]")).toHaveCount(0);
    if (info.project.name !== "mock") return;
    // The mock's C1 set has branches with stored leaves: none is drawn, and a discard asks no reason.
    await sidePanel(page).getByRole("treeitem", { name: /^4TB 與 8TB/ }).click();
    await branchBar(page).getByRole("button", { name: "不帶回" }).click();
    const dialog = page.getByRole("dialog", { name: "結束支線，不帶回" });
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("park from the composer and find it under 待處理 in the overlay", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no parking on the core-only server");
    await freshConversation(page, info, "frame=embed&lang=zh-TW", 1, "F4 embed");
    await composer(page).fill("要不要開外網存取？");
    await composer(page).locator("xpath=..").getByRole("button", { name: "停車" }).click();
    await expect(composer(page)).toHaveValue("");
    await page.getByRole("button", { name: "大綱" }).click();
    await expectInboxCount(page, 1);
    await openTab(page, "待處理");
    await expect(seedCard(page, "要不要開外網存取？")).toBeVisible();
    await shoot(page, "F4", `parking-420-${info.project.name}`);
    await expectAccessible(page);
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("park, then drop it from the bottom sheet; touch targets reach 44px", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no parking on the core-only server");
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 phone");
    await composer(page).fill("UPS 要不要買？");
    await composer(page).locator("xpath=..").getByRole("button", { name: "停車" }).tap();
    await expect(composer(page)).toHaveValue("");
    await page.getByRole("button", { name: "大綱" }).tap();
    await openTab(page, "待處理");
    const seed = seedCard(page, "UPS 要不要買？");
    const expand = seed.getByRole("button", { name: "展開成支線" });
    expect((await expand.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "F4", `parking-375-${info.project.name}`);
    await expectAccessible(page);
    await seed.getByRole("button", { name: "丟掉「UPS 要不要買？」" }).tap();
    await expect(seed).toContainText("已丟掉");
    await expectInboxCount(page, 0);
  });
});
