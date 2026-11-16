import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, MODERATE, shoot } from "./helpers";

/**
 * Scenario 1 (家用 NAS) through the F2 branch screens at the prototype's
 * widths, for the side-by-side check (docs/devlog/F2-web.md): A3 open a
 * branch, A4 the branch page and its fork peek, A5 the review and the card
 * in the main line, A6 promote. Mock only (the api project does not match
 * this file); shots are written only with
 * UPDATE_SCREENSHOTS=1. Also checks the screens with axe.
 */

const B3 = "4TB 與 8TB 硬碟的每 TB 成本與保固";

async function ready(page: Page): Promise<void> {
  await expect(page.getByRole("list", { name: "訊息" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Enters nas-b3 the way the prototype does: the fork pill of AI #2, then the branch in its list. */
async function enterB3(page: Page): Promise<void> {
  await page.getByRole("button", { name: /從這則岔出的支線：2 條支線/ }).click();
  await page.getByRole("list", { name: "從這則岔出的支線" }).getByRole("button", { name: new RegExp(B3) }).click();
  await expect(page.getByRole("region", { name: "支線資訊" })).toContainText(B3);
  await ready(page);
}

test.describe("scenario 1 branch screens", () => {
  test("1440: open, branch page, peek, review, promote, card", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?theme=light&lang=zh-TW");
    await ready(page);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByRole("dialog", { name: "開支線" })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a3-open");
    await page.keyboard.press("Escape");

    await enterB3(page);
    await shoot(page, "F2", "demo-1440-a4-branch");
    await page.getByRole("button", { name: "預覽分岔點" }).click();
    await expect(page.getByRole("dialog", { name: /分岔點 #2/ })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a4-peek");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "結束並帶回" }).click();
    const review = page.getByRole("dialog", { name: "結論卡" });
    // F10 §4.1: the review opens prefilled; the AI draft comes on request.
    await expect(review.getByRole("textbox", { name: /結論/ })).not.toHaveValue("");
    await review.getByRole("button", { name: "✨ 請 AI 濃縮結論草稿" }).click();
    await expect(review.getByText("AI 草稿・待你確認")).toBeVisible({ timeout: 10_000 });
    await shoot(page, "F2", "demo-1440-a5-review");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "升為主線" }).click();
    await expect(page.getByRole("dialog", { name: "把這條支線升為主線" })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a6-promote");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "回主線" }).click();
    const card = page.getByRole("region", { name: "結論卡" });
    await card.getByRole("button", { name: "展開全部欄位" }).click();
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "F2", "demo-1440-a5-card");
    await expectAccessible(page);
  });

  test("420 embedded and 375 phone: the branch page", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await page.goto("/?frame=embed&lang=zh-TW");
    await ready(page);
    await enterB3(page);
    await shoot(page, "F2", "demo-420-a4-branch");
    await expectAccessible(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?theme=light&lang=zh-TW");
    await ready(page);
    await enterB3(page);
    await shoot(page, "F2", "demo-375-a4-branch");
    await expectAccessible(page);
  });

  test("1440: the structure panel (outline, map, chapters) and the docked preview (phase 2)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?theme=light&lang=zh-TW");
    await ready(page);
    await expect(page.getByRole("tree", { name: "支線大綱" })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a8-outline");
    await page.getByRole("radio", { name: "地圖" }).click();
    await expect(page.getByRole("group", { name: "支線地圖" })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a8-map");
    await page.getByRole("radio", { name: "章節" }).click();
    await expect(page.getByRole("list", { name: "章節" })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a10-chapters");
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await expect(page.getByRole("region", { name: "送出前預覽" }).getByRole("button", { name: /規則/ })).toBeVisible();
    await shoot(page, "F2", "demo-1440-a11-preview");
    await expectAccessible(page);
  });
});
