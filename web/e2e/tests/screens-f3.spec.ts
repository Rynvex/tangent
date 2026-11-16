import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, MODERATE, shoot } from "./helpers";

/**
 * Scenario 1 (家用 NAS) through the F3 screens at the prototype's sizes, for
 * the side-by-side check (docs/devlog/F3-web.md): A9 notes, A13 settings, the
 * 420 embed in a mock developer tool, and a branch's unread divider. Mock
 * only (the api projects do not match this file); shots are written only
 * with UPDATE_SCREENSHOTS=1. Also checks the screens with axe.
 */

async function ready(page: Page): Promise<void> {
  await expect(page.getByRole("list", { name: "訊息" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe("scenario 1 F3 screens", () => {
  test("1440: notes, settings, the unread divider", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?theme=light&lang=zh-TW");
    await ready(page);
    await page.getByRole("tab", { name: "紀要" }).click();
    await expect(page.getByText(/這頁每一輪都會給 AI・約/)).toBeVisible();
    await shoot(page, "F3", "demo-1440-a9-notes");
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');

    await page.getByRole("button", { name: "設定" }).click();
    await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
    await shoot(page, "F3", "demo-1440-a13-settings");
    await page.keyboard.press("Escape");

    await page.goto("/?theme=light&lang=zh-TW&line=nas-b3");
    await ready(page);
    await expect(page.getByRole("separator", { name: "2 則未讀" })).toBeVisible();
    await shoot(page, "F3", "demo-1440-a4-unread");
    await expectAccessible(page);
  });

  test("1440 window: the 420 embed in the host's developer tool", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?frame=embed&lang=zh-TW");
    await ready(page);
    await shoot(page, "F3", "demo-1440-embed");
    await page.getByRole("button", { name: "大綱" }).click();
    await page.getByRole("tab", { name: "紀要" }).click();
    await expect(page.getByText(/這頁每一輪都會給 AI/)).toBeVisible();
    await shoot(page, "F3", "demo-1440-embed-notes");
    await expectAccessible(page);
  });

  test("375: notes in the bottom sheet", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?theme=light&lang=zh-TW");
    await ready(page);
    await page.getByRole("button", { name: "大綱" }).click();
    const sheet = page.getByRole("dialog", { name: "側欄" });
    await sheet.getByRole("tab", { name: "紀要" }).click();
    await expect(sheet.getByText(/這頁每一輪都會給 AI/)).toBeVisible();
    await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await shoot(page, "F3", "demo-375-a9-notes");
    await expectAccessible(page);
  });
});
