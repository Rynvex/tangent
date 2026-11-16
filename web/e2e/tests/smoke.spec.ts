import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

/**
 * Screenshots for the side-by-side check with the prototype are written next
 * to the F0 devlog only with UPDATE_SCREENSHOTS=1; a normal run never touches docs/.
 */
const SHOTS = fileURLToPath(new URL("../../../docs/devlog/screenshots/F0/", import.meta.url));
const UPDATE_SCREENSHOTS = process.env.UPDATE_SCREENSHOTS === "1";

async function shoot(page: Page, name: string): Promise<void> {
  if (UPDATE_SCREENSHOTS) await page.screenshot({ path: `${SHOTS}${name}.png` });
}
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Waits for the mock data and the self-hosted fonts, so screenshots are stable. */
async function ready(page: Page): Promise<void> {
  await expect(page.getByRole("navigation", { name: "路徑" }).locator('[aria-current="page"]')).toHaveText("主線");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

const SERIOUS = ["serious", "critical"];
const MODERATE = ["moderate", ...SERIOUS];

/** No axe violations at or above `impacts` (WCAG 2.2 AA rule set); the demo frame fails on serious+, package components on moderate+. */
async function expectAccessible(page: Page, impacts: readonly string[] = SERIOUS): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const blocking = results.violations.filter((violation) => impacts.includes(violation.impact ?? ""));
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("combobox", { name: "命令面板" })).toBeFocused();
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("three columns, side tabs, palette and shortcuts", async ({ page }) => {
    await page.goto("/?theme=light");
    await ready(page);
    await expect(page.getByRole("navigation", { name: "對話", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^家用 NAS 與備份策略/ })).toHaveAttribute("aria-current", "page");
    // zh-TW locale: @tangent/fonts/tc.css is loaded on demand. F10 §1 puts installed CJK faces first, so Plex Sans TC
    // only downloads where none is installed; check that its faces are registered rather than rendered.
    await expect.poll(() => page.evaluate(() => [...document.fonts].some((face) => face.family.replace(/"/g, "") === "IBM Plex Sans TC"))).toBe(true);
    const side = page.getByRole("complementary", { name: "側欄" });
    await expect(side.getByRole("tab")).toHaveText(["結構", "紀要", /待處理/]);
    // F4 / F5: the main line's openSeeds + openSuggestions + staleBranches (scenario 1: three parked seeds, one probe
    // suggestion and the cloud-backup branch, idle since the 14th).
    await expect(side.getByRole("tab", { name: /待處理/ })).toContainText("5");
    await shoot(page, "demo-1440-light");
    await expectAccessible(page);

    await openPalette(page);
    await shoot(page, "demo-1440-palette");
    await expectAccessible(page);
    await page.keyboard.type("側欄");
    await page.keyboard.press("Enter");
    await expect(side).toBeHidden();
    await page.keyboard.press("ControlOrMeta+.");
    await expect(side).toBeVisible();

    // F1: ⌘B opens the branch dialog's placeholder (the dialog itself is F2).
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByRole("dialog", { name: "開支線" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("dark theme with the AI error banner counting down", async ({ page }) => {
    await page.goto("/?theme=dark&state=aiError");
    await ready(page);
    const banner = page.locator('[data-tg-banner="aiError"]');
    await expect(banner).toContainText("秒後自動重試，第 2 / 3 次");
    await expect(page.getByRole("alert")).toContainText("正在重試，第 2 / 3 次");
    await shoot(page, "demo-1440-dark-aiError");
    await expectAccessible(page);
  });

  test("before C2 (no P1 feature): 結構 and 紀要, no 待處理", async ({ page }) => {
    await page.goto("/?theme=light&features=c1");
    await ready(page);
    const side = page.getByRole("complementary", { name: "側欄" });
    await expect(side.getByRole("tab")).toHaveText(["結構", "紀要"]);
  });

  test("core features only: no tab bar, just 結構", async ({ page }) => {
    await page.goto("/?theme=light&features=core");
    await ready(page);
    const side = page.getByRole("complementary", { name: "側欄" });
    await expect(side.getByRole("tablist")).toHaveCount(0);
    await expect(side.getByRole("heading", { name: "結構" })).toBeVisible();
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("conversation only, outline over it, host theme", async ({ page }) => {
    await page.goto("/?frame=embed");
    await ready(page);
    await expect(page.locator("[data-tg-root]")).toHaveAttribute("data-tg-theme", "host");
    await expect(page.getByRole("navigation", { name: "對話", exact: true })).toHaveCount(0);
    await shoot(page, "demo-420-embed-host");
    await expectAccessible(page);

    await page.getByRole("button", { name: "大綱" }).click();
    const side = page.getByRole("complementary", { name: "側欄" });
    await expect(side).toBeVisible();
    await shoot(page, "demo-420-embed-outline");
    await page.keyboard.press("Escape");
    await expect(side).toBeHidden();

    await openPalette(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("full-screen conversation, bottom sheet, touch-sized controls, no key hints", async ({ page }) => {
    await page.goto("/?theme=light");
    await ready(page);
    await expect(page.locator(".tg-kbd-hint").first()).toBeHidden();
    const settings = await page.getByRole("button", { name: "設定" }).boundingBox();
    expect(settings?.height).toBeGreaterThanOrEqual(44);
    await shoot(page, "demo-375-light");
    await expectAccessible(page);

    await page.getByRole("button", { name: "大綱" }).tap();
    const sheet = page.getByRole("dialog", { name: "側欄" });
    await expect(sheet).toBeVisible();
    await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await expect(sheet.getByRole("button", { name: "關閉側欄" })).toBeVisible();
    await shoot(page, "demo-375-sheet");
    await expectAccessible(page);
  });
});

test.describe("package components (gallery)", () => {
  test.use({ viewport: { width: 1024, height: 900 } });

  for (const theme of ["light", "dark", "host"] as const) {
    test(`no moderate+ axe findings, popups open, in ${theme}`, async ({ page }) => {
      await page.goto(`/?view=gallery&theme=${theme}`);
      await expect(page.getByRole("heading", { name: "元件總覽" })).toBeVisible();
      await expectAccessible(page, MODERATE);

      const popups = page.getByRole("region", { name: "浮層" });
      await popups.getByRole("button", { name: "開支線" }).click();
      await expect(page.getByRole("dialog", { name: "開支線" })).toBeVisible();
      await expectAccessible(page, MODERATE);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(popups.getByRole("button", { name: "開支線" })).toBeFocused();

      await page.getByRole("button", { name: "訊息動作" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await expectAccessible(page, MODERATE);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("button", { name: "訊息動作" })).toBeFocused();

      await popups.getByRole("button", { name: "預覽分岔點" }).click();
      await expect(page.getByRole("dialog", { name: "分岔點" })).toBeVisible();
      await expectAccessible(page, MODERATE);
      await page.keyboard.press("Escape");

      await page.getByRole("combobox", { name: "費用提示門檻" }).click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await expectAccessible(page, MODERATE);
      await page.keyboard.press("Escape");

      // F1 conversation components; the drawer comes last because the Select step above
      // must run with the page scrolled to the top (see docs/devlog/F1-web.md, axe on Base UI focus guards).
      await page.getByRole("button", { name: "打開送出前預覽" }).click();
      const preview = page.getByRole("dialog", { name: "送出前預覽" });
      await expect(preview.getByRole("button", { name: /規則/ })).toBeVisible();
      await expectAccessible(page, MODERATE);
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);

      // F2: the fork-point peek of the branch bar.
      await page.getByRole("region", { name: "支線元件" }).getByRole("button", { name: "預覽分岔點" }).first().click();
      await expect(page.getByRole("dialog", { name: /分岔點 #2/ })).toBeVisible();
      await expectAccessible(page, MODERATE);
      await page.keyboard.press("Escape");
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    });
  }
});
