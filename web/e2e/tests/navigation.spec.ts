import { expect, test, type Page } from "@playwright/test";
import { composer } from "./flows";
import { branchBar, outlineRow } from "./f5-flows";
import { isApi } from "./helpers";

/**
 * Back, forward, reload and pasted addresses (F18 §2.4) on the mock's NAS
 * scenario: `?line=<lineId>&m=<messageId>` names the conversation on screen;
 * going to another line adds a history entry, a message within the line does not.
 */

const Q = "theme=light&lang=zh-TW";
const BRANCH_PURPOSE = "4TB 與 8TB 硬碟的每 TB 成本與保固";
const addressOf = (page: Page) => new URL(page.url()).searchParams;
const message = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);

test.beforeEach(({}, info) => test.skip(isApi(info), "The navigation flows run on the mock's scenario"));

test.use({ viewport: { width: 1440, height: 900 } });

test("back returns from a branch to the main line, forward returns to the branch", async ({ page }) => {
  await page.goto(`/?${Q}&line=nas`);
  await expect(composer(page)).toBeVisible();
  await expect(branchBar(page)).toHaveCount(0);

  await outlineRow(page, BRANCH_PURPOSE).click();
  await expect(branchBar(page)).toContainText(BRANCH_PURPOSE);
  expect(addressOf(page).get("line")).toBe("nas-b3");
  // The frame's own parameters are not lost on the way.
  expect(addressOf(page).get("theme")).toBe("light");

  await page.goBack();
  await expect(branchBar(page)).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  expect(addressOf(page).get("line")).toBe("nas");

  await page.goForward();
  await expect(branchBar(page)).toContainText(BRANCH_PURPOSE);
  expect(addressOf(page).get("line")).toBe("nas-b3");
});

test("a reload comes back to the same line", async ({ page }) => {
  await page.goto(`/?${Q}&line=nas`);
  await outlineRow(page, BRANCH_PURPOSE).click();
  await expect(branchBar(page)).toContainText(BRANCH_PURPOSE);

  await page.reload();
  await expect(branchBar(page)).toContainText(BRANCH_PURPOSE);
  expect(addressOf(page).get("line")).toBe("nas-b3");
});

test("an address with line and m opens on that message", async ({ page }) => {
  await page.goto(`/?${Q}&line=nas-b3&m=nas-b3-1`);
  await expect(branchBar(page)).toContainText(BRANCH_PURPOSE);
  await expect(message(page, "nas-b3-1")).toBeInViewport();

  await page.goto(`/?${Q}&line=nas&m=nas-m18`);
  await expect(composer(page)).toBeVisible();
  await expect(message(page, "nas-m18")).toBeInViewport();
  expect(addressOf(page).get("m")).toBe("nas-m18");
});

test("a line that does not exist gives way to the first conversation, without a new entry", async ({ page }) => {
  await page.goto(`/?${Q}&line=${encodeURIComponent("gone-for-good")}`);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "對話", exact: true }).locator('[aria-current="page"]')).toHaveCount(1);
  await expect.poll(() => addressOf(page).get("line")).not.toBe("gone-for-good");
  expect(addressOf(page).get("line")).not.toBeNull();
  expect(addressOf(page).get("m")).toBeNull();
  expect(addressOf(page).get("theme")).toBe("light");

  // Nothing was added: back leaves for the page before this one (about:blank), not to the missing line.
  await page.goBack();
  expect(page.url()).toBe("about:blank");
});
