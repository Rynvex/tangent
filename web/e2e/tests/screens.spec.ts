import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, shoot } from "./helpers";

/**
 * Scenario 1 (家用 NAS) rendered by the F1 components at the prototype's
 * widths, for the side-by-side check (docs/devlog/F1-web.md); also asserts
 * the Markdown pieces render. Shots are written only with UPDATE_SCREENSHOTS=1.
 */

async function ready(page: Page): Promise<void> {
  await expect(page.getByRole("list", { name: "訊息" })).toBeVisible();
  await expect(page.locator("[data-tg-code] pre").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

test.describe("scenario 1 screens", () => {
  test("1440 light and dark: table, code, card, fork marker, suggestions", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?theme=light");
    await ready(page);
    await expect(page.getByRole("region", { name: "結論卡" })).toBeVisible();
    await expect(page.getByRole("group", { name: "AI 建議開支線" })).toBeVisible();
    await page.getByRole("list", { name: "訊息" }).locator("table").first().scrollIntoViewIfNeeded();
    await shoot(page, "F1", "demo-1440-light-table");
    await page.getByRole("group", { name: "AI 建議開支線" }).scrollIntoViewIfNeeded();
    await shoot(page, "F1", "demo-1440-light");
    // F12 S7: the meter opens the context breakdown, which leads to the full send preview.
    await page.getByRole("button", { name: /token/ }).first().click();
    await page.getByRole("dialog", { name: "下一輪會送出的上下文" }).getByRole("button", { name: "送出前預覽完整內容" }).click();
    await expect(page.getByRole("region", { name: "送出前預覽" }).getByRole("button", { name: /規則/ })).toBeVisible();
    await shoot(page, "F1", "demo-1440-preview");
    await page.keyboard.press("Escape");

    await page.goto("/?theme=dark&state=aiError");
    await ready(page);
    await shoot(page, "F1", "demo-1440-dark-aiError");
    await expectAccessible(page);
  });

  test("420 embedded, host theme", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto("/?frame=embed");
    await ready(page);
    await page.getByRole("group", { name: "AI 建議開支線" }).scrollIntoViewIfNeeded();
    await shoot(page, "F1", "demo-420-embed-host");
  });

  test("375 phone: the code block scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?theme=light");
    await ready(page);
    const pre = page.locator("[data-tg-code] pre").first();
    await pre.scrollIntoViewIfNeeded();
    const overflow = await pre.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(true);
    await shoot(page, "F1", "demo-375-light");
  });
});
