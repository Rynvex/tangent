import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, MODERATE, shoot } from "./helpers";
import { composer, freshConversation, replies } from "./flows";

/**
 * F3 設定 (A13), on the mock and the reference server: the theme (light,
 * dark, follow the system) and the cost threshold are kept in this browser;
 * a turn estimated above the threshold shows its cost next to the composer.
 * G2: the settings are a page of categories (search on the left, cards of
 * rows on the right); the theme and the cost threshold are under 外觀, this
 * conversation's model and the feature list under 對話串.
 */

/** About 7.5k tokens: US$0.02–0.03 at US$3 per million input tokens (the mock's and the e2e server's fake-1 price). */
const LONG_DRAFT = "word ".repeat(6_000);

const appRoot = (page: Page) => page.locator("[data-tg-root]").first();

type Category = "一般" | "外觀" | "對話" | "快捷鍵" | "供應商" | "對話串" | "維護" | "封存" | "關於";

/** Opens the settings on a category (it opens on 一般). */
async function openSettings(page: Page, category: Category = "外觀") {
  await page.getByRole("button", { name: "設定" }).click();
  const dialog = page.getByRole("dialog", { name: "設定" });
  await expect(dialog).toBeVisible();
  if (category !== "一般") await dialog.getByRole("navigation", { name: "設定分類" }).getByRole("button", { name: category, exact: true }).click();
  return dialog;
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("theme and cost threshold, kept across a reload", async ({ page }, info) => {
    await freshConversation(page, info, "lang=zh-TW");
    await expect(appRoot(page)).not.toHaveAttribute("data-tg-theme");

    const dialog = await openSettings(page);
    await expect(dialog.getByRole("radio", { name: "跟隨系統" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("radiogroup", { name: "費用提醒門檻" }).getByRole("radio", { name: "US$0.05" })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("radio", { name: "深色" }).click();
    await expect(appRoot(page)).toHaveAttribute("data-tg-theme", "dark");
    await shoot(page, "F3", `settings-1440-${info.project.name}`);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    if (info.project.name !== "mock") {
      // The server lists its models (B5 /capabilities.models); new lines take fake-1 (priced). Pick it if the line has another.
      const models = await openSettings(page, "對話串");
      const select = models.getByRole("combobox", { name: "模型", exact: true });
      await expect(select).toBeVisible();
      if (!(await select.textContent())?.includes("fake-1")) {
        await select.click();
        await page.getByRole("option", { name: "fake・fake-1" }).click();
        await expect(models.getByText("已改用 fake-1。")).toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(models).toBeHidden();
    }

    // Above US$0.02 but below the default US$0.05: no cost yet.
    await composer(page).fill(LONG_DRAFT);
    await expect(page.getByRole("button", { name: /送出前預覽 \(.+ token\)/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/這一輪約 US\$/)).toHaveCount(0);

    const again = await openSettings(page);
    await again.getByRole("radiogroup", { name: "費用提醒門檻" }).getByRole("radio", { name: "US$0.02" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByText(/這一輪約 US\$0\.0\d/)).toBeVisible();

    await page.reload();
    await expect(appRoot(page)).toHaveAttribute("data-tg-theme", "dark");
    await composer(page).fill(LONG_DRAFT);
    await expect(page.getByText(/這一輪約 US\$0\.0\d/)).toBeVisible({ timeout: 10_000 });

    const last = await openSettings(page);
    await last.getByRole("radio", { name: "跟隨系統" }).click();
    await expect(appRoot(page)).not.toHaveAttribute("data-tg-theme");
  });

  test("this conversation's model and the feature list from /capabilities", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW");
    const dialog = await openSettings(page, "對話串");
    await expect(dialog.getByRole("heading", { name: "這個對話" })).toBeVisible();
    await expect(dialog.getByText("支線與結論卡")).toBeVisible();
    await expect(dialog.getByText("紀要", { exact: true })).toBeVisible();
    // The host decides every mode (DESIGN §12 F3); the page only shows them.
    await expect(dialog.getByRole("radiogroup", { name: "建議開支線" })).toHaveCount(0);
    await expect(dialog.getByText(/由宿主決定：/).first()).toBeVisible();
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the host decides the theme; the threshold still applies", async ({ page }, info) => {
    await freshConversation(page, info, "frame=embed&lang=zh-TW");
    const dialog = await openSettings(page);
    await expect(dialog.getByText("嵌入時由宿主決定主題。")).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "深色" })).toHaveCount(0);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("settings fill the screen with touch-sized choices", async ({ page }, info) => {
    await freshConversation(page, info, "lang=zh-TW");
    const dialog = await openSettings(page);
    const dark = dialog.getByRole("radio", { name: "深色" });
    expect((await dark.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await dark.tap();
    await expect(appRoot(page)).toHaveAttribute("data-tg-theme", "dark");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
  });
});

/** G2: the Settings page itself, on the mock (its preferences are the browser's, whatever the server). */
test.describe("G2 settings page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("search jumps to a setting; dark, chat width and the send key apply at once and survive a reload", async ({ page }, info) => {
    test.skip(info.project.name !== "mock", "browser-side preferences: the mock run covers them");
    await freshConversation(page, info, "lang=zh-TW");
    const dialog = await openSettings(page, "一般");
    await expect(dialog.getByRole("navigation", { name: "設定分類" }).getByRole("button")).toHaveText(["一般", "外觀", "對話", "快捷鍵", "供應商", "對話串", "維護", "封存", "關於"]);

    // `/` goes to the search; a result jumps to its category and lights the row.
    await page.keyboard.press("/");
    await expect(dialog.getByRole("searchbox", { name: "搜尋設定" })).toBeFocused();
    await page.keyboard.type("對話寬度");
    await dialog.getByRole("region", { name: "搜尋結果" }).getByRole("button", { name: /對話寬度/ }).click();
    await expect(dialog.locator('[data-setting="chatWidth"]')).toHaveAttribute("data-highlighted", "true");
    await expect(dialog.locator('[data-setting="chatWidth"]')).toBeInViewport();

    await dialog.getByRole("radiogroup", { name: "對話寬度" }).getByRole("radio", { name: "全寬" }).click();
    await dialog.getByRole("radio", { name: "深色" }).click();
    await expect(appRoot(page)).toHaveAttribute("data-tg-theme", "dark");
    await dialog.getByRole("navigation", { name: "設定分類" }).getByRole("button", { name: "對話", exact: true }).click();
    await dialog.getByRole("radiogroup", { name: "送出鍵" }).getByRole("radio", { name: "Ctrl+Enter 送出" }).click();
    await shoot(page, "G2", "settings-chat-1440-dark");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    const column = page.locator("[data-tg-chat-width]");
    await expect(column).toHaveAttribute("data-tg-chat-width", "full");
    const wide = (await column.boundingBox())?.width ?? 0;
    expect(wide).toBeGreaterThan(46 * 16);

    // Enter breaks the line now; Ctrl+Enter sends.
    const before = await replies(page).count();
    await composer(page).fill("第一行");
    await composer(page).press("Enter");
    await expect(composer(page)).toHaveValue("第一行\n");
    await expect(replies(page)).toHaveCount(before);
    await composer(page).press("Control+Enter");
    await expect(replies(page)).toHaveCount(before + 1);

    await page.reload();
    await expect(appRoot(page)).toHaveAttribute("data-tg-theme", "dark");
    await expect(page.locator("[data-tg-chat-width]")).toHaveAttribute("data-tg-chat-width", "full");
    await expect(page.getByText(/Ctrl\+Enter 送出・Enter 換行/)).toBeVisible();

    // Restore defaults puts all three back.
    const again = await openSettings(page, "一般");
    await again.getByRole("button", { name: "還原預設值" }).click();
    await again.getByRole("group", { name: "還原預設值" }).getByRole("button", { name: "還原", exact: true }).click();
    await expect(again.getByText("所有設定已還原成預設值。")).toBeVisible();
    await expect(appRoot(page)).not.toHaveAttribute("data-tg-theme");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-tg-chat-width]")).toHaveAttribute("data-tg-chat-width", "reading");
  });

  test("the language switches without a reload", async ({ page }, info) => {
    test.skip(info.project.name !== "mock", "browser-side preferences: the mock run covers them");
    // No ?lang=: the setting decides (the browser's locale here is zh-TW).
    await freshConversation(page, info, "");
    const dialog = await openSettings(page, "一般");
    await dialog.getByRole("radiogroup", { name: "介面語言" }).getByRole("radio", { name: "English" }).click();
    const english = page.getByRole("dialog", { name: "Settings" });
    await expect(english.getByRole("radiogroup", { name: "Interface language" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  });

  test("375 phone: one column, the categories in a row above it", async ({ page }, info) => {
    test.skip(info.project.name !== "mock", "browser-side preferences: the mock run covers them");
    await page.setViewportSize({ width: 375, height: 812 });
    await freshConversation(page, info, "lang=zh-TW");
    const dialog = await openSettings(page, "外觀");
    const nav = await dialog.getByRole("navigation", { name: "設定分類" }).boundingBox();
    const content = await dialog.getByRole("region", { name: "外觀" }).boundingBox();
    expect(nav && content && nav.y + nav.height <= content.y + 1).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectAccessible(page, MODERATE, '[role="dialog"]');
  });
});
