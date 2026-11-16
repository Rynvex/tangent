import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectAccessible, hoverMessage, shoot } from "./helpers";
import { composer, freshConversation, replies, sidePanel } from "./flows";

/**
 * F3 功能開關的呈現 (handoff 其他決定, §9-8): off = not rendered, and the
 * three sets the demo switches between — everything, C1, and only the core.
 * The mock switches with `?features=` (or the settings dialog); the server
 * reports its own: `api` runs the reference server's default features,
 * `api-core` one started with TANGENT_FEATURES=none.
 */

type FeatureSet = "all" | "c1" | "core";

const projectSet = (info: TestInfo): FeatureSet | null => (info.project.name === "api" ? "c1" : info.project.name === "api-core" ? "core" : null);

/** The names of the last reply's toolbar buttons (F8 S1: three and 「更多動作」), of its menu (a parked list's item aside), and of the composer's toolbar. */
async function controls(page: Page): Promise<{ actions: string[]; menu: string[]; composer: string[] }> {
  const last = replies(page).last();
  await hoverMessage(last);
  const names = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""));
  const actions = await names(last.locator("[data-tg-actions] > button"));
  let menu: string[] = [];
  if (actions.includes("更多動作")) {
    await last.getByRole("button", { name: "更多動作" }).click();
    await expect(page.getByRole("menu").first()).toBeVisible();
    menu = (await names(page.getByRole("menu").first().getByRole("menuitem"))).filter((name) => !name.startsWith("將清單存入停車場"));
    await page.keyboard.press("Escape");
  }
  return { actions, menu, composer: await names(composer(page).locator("xpath=..").locator("button")) };
}

async function open(page: Page, info: TestInfo, set: FeatureSet): Promise<void> {
  if (info.project.name === "mock") {
    await page.goto(`/?theme=light&lang=zh-TW&features=${set}&line=nas`);
    await expect(replies(page).last()).toBeVisible();
  } else {
    await freshConversation(page, info, "theme=light&lang=zh-TW");
  }
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const set of ["all", "c1", "core"] as const) {
    test(`feature set: ${set}`, async ({ page }, info) => {
      const forced = projectSet(info);
      test.skip(forced !== null && forced !== set, `the ${info.project.name} server runs the ${forced} set`);
      await open(page, info, set);
      const side = sidePanel(page);
      const { actions, menu, composer: tools } = await controls(page);

      if (set === "core") {
        // Only the core: no tab bar, just 結構; a reply offers branch, pin and copy; the composer branch and preview.
        await expect(side.getByRole("tablist")).toHaveCount(0);
        await expect(side.getByRole("heading", { name: "結構" })).toBeVisible();
        // 釘選 is core (B9, DESIGN §12): it stays with branch and copy; 分岔重答 (F8 S7) and 從這則抽成支線… (B18, F13) are core too, in 「更多動作」.
        expect(actions).toEqual(["從這則開支線", "釘選", "複製訊息", "更多動作"]);
        expect(menu).toEqual(["分岔重答（可換模型）…", "從這則抽成支線…"]);
        expect(tools).toEqual([expect.stringMatching(/^模型：/), "開支線", expect.stringMatching(/^送出前預覽/), "送出"]);
        await expect(side.getByRole("radio", { name: "章節" })).toHaveCount(0);
        await expect(page.getByRole("group", { name: "AI 建議開支線" })).toHaveCount(0);
      } else {
        const tabs = set === "all" ? ["結構", "紀要", "待處理"] : info.project.name === "mock" ? ["結構", "紀要"] : ["結構", "紀要", "待處理"];
        await expect(side.getByRole("tab")).toHaveText(tabs.map((tab) => new RegExp(`^${tab}`)));
        // Parking (B3, F4): on in the mock's full set and on the reference server, off in the mock's C1 set.
        const parking = set === "all" || info.project.name !== "mock";
        // Spinoff (B2, F4 phase 2) goes with parking here: both on in the full set and on the server, off in C1.
        // Relations (C3, F5), diverge (D3) and folds (D4, F6) go with them too; 釘選 is core.
        // F8 S1: three in view (停車 takes 釘選's place when parking is on), the rest in 「更多動作」 by use.
        expect(actions).toEqual(parking ? ["從這則開支線", "停車", "複製訊息", "更多動作"] : ["從這則開支線", "釘選", "複製訊息", "更多動作"]);
        // F10: 記成備忘 follows 記進紀要 while memos are on (the mock's full set); F19: 存進名詞表 follows it while the glossary is on;
        // F13's 從這則抽成支線… (core) comes before 從這裡開新對話.
        const full = ["分岔重答（可換模型）…", "給我幾個方向…", "記進紀要", "記成備忘", "存進名詞表", "從這則抽成支線…", "從這裡開新對話", "關聯…", "從這則起折疊…", "釘選", "標論證類型…"];
        if (info.project.name === "mock") expect(menu).toEqual(parking ? full : ["分岔重答（可換模型）…", "記進紀要", "從這則抽成支線…"]);
        else expect(menu).toEqual(expect.arrayContaining(full.slice(0, -1).filter((item) => item !== "記成備忘")));
        expect(tools).toEqual(
          parking
            ? [expect.stringMatching(/^模型：/), "開支線", "停車", expect.stringMatching(/^送出前預覽/), "送出"]
            : [expect.stringMatching(/^模型：/), "開支線", expect.stringMatching(/^送出前預覽/), "送出"],
        );
        await expect(side.getByRole("radio", { name: "章節" })).toBeVisible();
        if (info.project.name === "mock") await expect(page.getByRole("group", { name: "AI 建議開支線" })).toHaveCount(set === "all" ? 1 : 0);
      }
      // No holes: the composer's controls sit in one row, left to right.
      const middles = await composer(page)
        .locator("xpath=..")
        .locator("button")
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect()).map((box) => Math.round(box.top + box.height / 2)));
      expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(1);
      await shoot(page, "F3", `features-${set}-${info.project.name}`);
      await expectAccessible(page);
    });
  }

  test("the settings dialog switches the mock's feature set", async ({ page }, info) => {
    test.skip(info.project.name !== "mock", "only the mock can change its features");
    await open(page, info, "all");
    await expect(page.getByRole("group", { name: "AI 建議開支線" })).toBeVisible();
    await page.getByRole("button", { name: "設定" }).click();
    const dialog = page.getByRole("dialog", { name: "設定" });
    // G2: the feature list is on the 對話串 page.
    await dialog.getByRole("navigation", { name: "設定分類" }).getByRole("button", { name: "對話串" }).click();
    // Modes are read-only (DESIGN §12 F3).
    await expect(dialog.getByRole("radiogroup", { name: "建議開支線" })).toHaveCount(0);
    await dialog.getByRole("radiogroup", { name: "功能組合（mock）" }).getByRole("radio", { name: "只有核心" }).click();
    await expect(page).toHaveURL(/features=core/);
    await expect(sidePanel(page).getByRole("heading", { name: "結構" })).toBeVisible();
    await expect(sidePanel(page).getByRole("tablist")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "AI 建議開支線" })).toHaveCount(0);
  });
});
