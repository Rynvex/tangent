import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible, MODERATE, shoot, messageAction } from "./helpers";
import { composer, freshConversation, replies, sidePanel, toast, turn } from "./flows";

/**
 * F3 紀要 (A9), on the mock and the reference server: add, edit in place,
 * replace, tick a to-do, save a reply and a selection to the notes (the
 * message action and ⌘⇧N), keep an aside's answer, follow a note's source;
 * at 1440, 420 (embedded) and 375 (phone).
 */

const notesTab = async (page: Page) => {
  await sidePanel(page).getByRole("tab", { name: "紀要" }).click();
  await expect(page.getByText(/這頁每一輪都會給 AI/)).toBeVisible();
};
const section = (page: Page, name: string): Locator => sidePanel(page).getByRole("region", { name: new RegExp(`^${name}`) });

async function addNote(page: Page, sectionName: string, text: string): Promise<void> {
  await sidePanel(page).getByRole("button", { name: "新增" }).click();
  const form = page.getByRole("group", { name: "新增紀要" });
  await form.getByRole("radio", { name: sectionName }).click();
  await form.getByRole("textbox", { name: "內容" }).fill(text);
  await form.getByRole("textbox", { name: "內容" }).press("Enter");
  await expect(form).toBeHidden();
  await expect(section(page, sectionName).getByText(text, { exact: true })).toBeVisible();
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("add, edit, replace and tick notes; the page says it goes to the AI every turn", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW");
    await notesTab(page);
    await addNote(page, "已確認的事實", "The trip is in November");
    await expect(page.getByText(/這頁每一輪都會給 AI・約 \d+ \/ 2k token/)).toBeVisible();

    // Edit in place: click the text, Enter saves.
    const facts = section(page, "已確認的事實");
    await facts.getByRole("button", { name: "The trip is in November" }).click();
    const box = facts.getByRole("textbox", { name: "修改紀要" });
    await box.fill("The trip is in mid-November");
    await box.press("Enter");
    await expect(facts.getByRole("button", { name: "The trip is in mid-November" })).toBeVisible();

    // Replace: the old one is kept, struck through, behind 顯示被取代的 1 條.
    await facts.getByRole("listitem").first().hover();
    await facts.getByRole("button", { name: "取代" }).click();
    const replace = facts.getByRole("textbox", { name: "新的內容（舊的會劃掉保留）" });
    await replace.fill("The trip is in early December");
    await facts.getByRole("button", { name: "儲存" }).click();
    await expect(facts.getByRole("button", { name: "The trip is in early December" })).toBeVisible();
    await facts.getByRole("button", { name: "顯示被取代的 1 條" }).click();
    await expect(facts.locator("s", { hasText: "The trip is in mid-November" })).toBeVisible();
    await expect(facts.getByText("已由「The trip is in early December」取代")).toBeVisible();

    // Replacing something to confirm makes it a confirmed fact by default (R5); the old one stays under 待確認.
    await addNote(page, "待確認", "Is the JR pass worth it?");
    const toConfirm = section(page, "待確認");
    await toConfirm.getByRole("listitem").first().hover();
    await toConfirm.getByRole("button", { name: "取代" }).click();
    await expect(toConfirm.getByRole("radiogroup", { name: "區塊" }).getByRole("radio", { name: "已確認的事實" })).toHaveAttribute("aria-checked", "true");
    await toConfirm.getByRole("textbox", { name: "新的內容（舊的會劃掉保留）" }).fill("The JR pass pays off in 4 days");
    await toConfirm.getByRole("button", { name: "儲存" }).click();
    await expect(facts.getByRole("button", { name: "The JR pass pays off in 4 days" })).toBeVisible();
    await toConfirm.getByRole("button", { name: "顯示被取代的 1 條" }).click();
    await expect(toConfirm.locator("s", { hasText: "Is the JR pass worth it?" })).toBeVisible();

    // A to-do, ticked done.
    await addNote(page, "待辦", "Book the JR pass");
    const done = section(page, "待辦").getByRole("checkbox", { name: "完成：Book the JR pass" });
    await done.click();
    await expect(done).toHaveAttribute("aria-checked", "true");
    await expect(section(page, "待辦").locator("s", { hasText: "Book the JR pass" })).toBeVisible();

    await shoot(page, "F3", `notes-1440-${info.project.name}`);
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
    // Reloaded from the server, everything is still there (the mock starts over on a reload).
    if (info.project.name === "mock") return;
    await page.reload();
    await notesTab(page);
    await expect(section(page, "已確認的事實").getByRole("button", { name: "The trip is in early December" })).toBeVisible();
    await expect(section(page, "已確認的事實").getByRole("button", { name: "The JR pass pays off in 4 days" })).toBeVisible();
    await expect(section(page, "待辦").getByRole("checkbox", { name: "完成：Book the JR pass" })).toHaveAttribute("aria-checked", "true");
  });

  test("save a reply and a selection to the notes, then follow the source back", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 2);
    await notesTab(page);
    const first = replies(page).first();
    await first.hover();
    await messageAction(first, "記進紀要");
    await expect(toast(page)).toHaveText("已記進紀要的「待確認」。");
    const toConfirm = section(page, "待確認");
    await expect(toConfirm.getByRole("listitem")).toHaveCount(1);
    const saved = await toConfirm.getByRole("listitem").first().getByRole("button").first().innerText();
    await expect(first).toContainText(saved.slice(0, 15));
    await expect(toConfirm.getByRole("button", { name: "到來源：主線 #2" })).toBeVisible();

    // A selection inside the last reply, saved with ⌘⇧N.
    const last = replies(page).last();
    await last.locator("p").first().evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await expect(page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "記進紀要" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+N");
    await expect(toConfirm.getByRole("listitem")).toHaveCount(2);
    await expect(toConfirm.getByRole("button", { name: "到來源：主線 #4" })).toBeVisible();

    // Following a source scrolls to that message.
    await composer(page).click();
    await page.getByRole("list", { name: "訊息" }).evaluate((element) => element.closest(".overflow-auto")?.scrollTo(0, 99_999));
    await toConfirm.getByRole("button", { name: "到來源：主線 #2" }).click();
    await expect(first).toBeInViewport();
  });

  test("keep an aside's answer: it goes into the confirmed facts with the aside as its source", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW");
    const last = replies(page).last();
    await last.hover();
    await messageAction(last, "從這則開支線");
    const dialog = page.getByRole("dialog", { name: "開支線" });
    await dialog.getByRole("textbox", { name: /目的/ }).fill("Is the JR pass worth it");
    await dialog.getByRole("radio", { name: /順口問/ }).click();
    await dialog.getByRole("button", { name: "開支線" }).click();
    await expect(dialog).toBeHidden();
    await turn(page, "Is the JR pass worth it for 4 days?");
    const bar = page.getByRole("region", { name: "支線資訊" });
    await bar.getByRole("button", { name: "記進紀要" }).click();
    const keep = page.getByRole("dialog", { name: "把答案記進紀要" });
    await expect(keep.getByRole("combobox")).toContainText("已確認的事實");
    await keep.getByRole("button", { name: "記進紀要" }).click();
    await expect(keep).toBeHidden();
    await notesTab(page);
    await expect(section(page, "已確認的事實").getByRole("button", { name: /到來源：順口問・Is the JR pass worth it/ })).toBeVisible();
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the notes open over the conversation from the top button", async ({ page }, info) => {
    await freshConversation(page, info, "frame=embed&lang=zh-TW");
    await page.getByRole("button", { name: "大綱" }).click();
    await notesTab(page);
    await addNote(page, "待確認", "Is Nara a day trip");
    await shoot(page, "F3", `notes-420-${info.project.name}`);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(sidePanel(page)).toBeHidden();
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("the notes are a tab of the bottom sheet", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW");
    await page.getByRole("button", { name: "大綱" }).tap();
    await notesTab(page);
    await addNote(page, "已決定", "Stay in Kyoto Station area");
    const add = sidePanel(page).getByRole("button", { name: "新增" });
    expect((await add.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "F3", `notes-375-${info.project.name}`);
    await expectAccessible(page);
  });
});
