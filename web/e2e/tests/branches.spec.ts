import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { API, expectAccessible, isApi, MODERATE, shoot, messageAction } from "./helpers";

/**
 * F2 phase 1, the branch flow, against the mock (project `mock`) and the
 * reference server with the fake runner (project `api`), at 1440, 420
 * (embedded) and 375 (phone): open a branch → talk in it → draft → review →
 * bring back → the card shows in the main line → after the next turn the AI
 * has been told. Plus one run each of "don't bring back", "make main line"
 * and "move into a branch".
 */

const composer = (page: Page) => page.getByRole("textbox", { name: "訊息" });
const replies = (page: Page) => page.locator("article[data-tg-message]");
const branchBar = (page: Page) => page.getByRole("region", { name: "支線資訊" });
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });
/** A user message by its exact text (the fake runner's reply repeats it). */
const said = (page: Page, text: string) => page.getByText(text, { exact: true });

/** Sends a message and waits until its reply is done. */
async function turn(page: Page, text: string): Promise<void> {
  const before = await replies(page).count();
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(replies(page)).toHaveCount(before + 1);
  await expect(replies(page).nth(before)).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
}

/** A fresh conversation with `turns` finished turns: from the list, the phone drawer, or (embedded) the API. */
async function startConversation(page: Page, info: TestInfo, via: "list" | "drawer" | "embed", turns = 1): Promise<void> {
  if (via === "embed") {
    if (isApi(info)) {
      const response = await page.request.post(`${API.url()}/lines`, { headers: { Authorization: `Bearer ${API.token()}` }, data: { title: "Embedded branches" } });
      expect(response.status()).toBe(201);
      const line = (await response.json()) as { id: string };
      await page.goto(`/?frame=embed&lang=zh-TW&line=${line.id}`);
    } else {
      await page.goto("/?frame=embed&lang=zh-TW&line=okr");
    }
  } else {
    await page.goto("/?theme=light&lang=zh-TW");
    if (via === "drawer") await page.getByRole("button", { name: "展開對話清單" }).click();
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: "新對話" }).first().click();
  }
  await expect(composer(page)).toBeVisible();
  // The new (empty) conversation is on screen before anything is counted.
  await expect(page.getByText("還沒有訊息。在下方輸入第一則。")).toBeVisible();
  for (let i = 1; i <= turns; i += 1) await turn(page, `Question ${i} about the Kyoto trip`);
}

/** Opens a branch from the last reply through its message action. */
async function openBranch(page: Page, purpose: string, kind: "查證" | "另一條路" = "查證", from = replies(page).last()): Promise<void> {
  await from.hover();
  await messageAction(from, "從這則開支線");
  const dialog = page.getByRole("dialog", { name: "開支線" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /目的/ }).fill(purpose);
  await dialog.getByRole("radio", { name: new RegExp(kind) }).click();
  await expectAccessible(page, MODERATE, '[role="dialog"]');
  await dialog.getByRole("button", { name: "開支線" }).click();
  await expect(dialog).toBeHidden();
  await expect(branchBar(page)).toContainText(purpose);
  await expect(path(page).locator('[aria-current="page"]')).toContainText(purpose);
}

async function bringBack(page: Page, info: TestInfo, width: number): Promise<void> {
  await branchBar(page).getByRole("button", { name: "結束並帶回" }).click();
  const review = page.getByRole("dialog", { name: "結論卡" });
  await expect(review).toBeVisible();
  // F10 §4.1: it opens at once with the branch's purpose and last reply; the AI draft comes on request.
  await expect(review.getByRole("textbox", { name: /問題/ })).not.toHaveValue("");
  await expect(review.getByRole("textbox", { name: /結論/ })).not.toHaveValue("");
  await expect(review.getByRole("button", { name: /展開進階欄位/ })).toHaveAttribute("aria-expanded", "false");
  await review.getByRole("button", { name: "✨ 請 AI 濃縮結論草稿" }).click();
  await expect(review.getByText("AI 草稿・待你確認")).toBeVisible({ timeout: 30_000 });
  await expect(review.getByRole("textbox", { name: /結論/ })).not.toHaveValue("");
  await shoot(page, "F2", `review-${width}-${info.project.name}`);
  await expectAccessible(page, MODERATE, '[role="dialog"]');
  await review.getByRole("button", { name: "全部接受並帶回" }).click();
  await expect(review).toBeHidden();
}

async function cardIsToldNextTurn(page: Page): Promise<void> {
  const card = page.getByRole("region", { name: "結論卡" }).last();
  await expect(card).toBeVisible();
  await expect(path(page).locator('[aria-current="page"]')).toHaveText("主線");
  await expect(card.getByText("下一輪才會告訴 AI")).toBeVisible();
  await expectAccessible(page);
  await turn(page, "Thanks, what next?");
  await expect(card.getByText("已告訴 AI")).toBeVisible();
  await expect(card.getByText("下一輪才會告訴 AI")).toHaveCount(0);
}

async function mainFlow(page: Page, info: TestInfo, via: "list" | "drawer" | "embed", width: number): Promise<void> {
  await startConversation(page, info, via);
  await openBranch(page, "Rail passes for Kansai");
  await expectAccessible(page);
  await turn(page, "Which pass covers Nara?");
  await shoot(page, "F2", `branch-${width}-${info.project.name}`);
  await bringBack(page, info, width);
  await cardIsToldNextTurn(page);
  await shoot(page, "F2", `card-${width}-${info.project.name}`);
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("open a branch, talk, draft, review, bring back, the AI is told", async ({ page }, info) => {
    await mainFlow(page, info, "list", 1440);
  });

  test("move the last messages into a branch", async ({ page }, info) => {
    await startConversation(page, info, "list", 2);
    const own = said(page, "Question 2 about the Kyoto trip").locator("xpath=ancestor::li[1]");
    await own.hover();
    // F13 S3: 從這則抽成支線… takes any stretch; from the last question it runs to the end by default.
    await messageAction(own, "從這則抽成支線…");
    const dialog = page.getByRole("dialog", { name: /^從 #\d+ 抽成支線$/ });
    await expect(dialog.getByText("從", { exact: true }).locator("xpath=following-sibling::*[1]")).toContainText("Question 2 about the Kyoto trip");
    await dialog.getByRole("checkbox", { name: /直接標為已帶回/ }).click();
    await dialog.getByRole("textbox", { name: "目的" }).fill("Second question");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "抽成支線", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("訊息已搬到支線")).toBeVisible();
    await expect(said(page, "Question 2 about the Kyoto trip")).toHaveCount(0);
    await page.getByRole("button", { name: "看支線" }).click();
    await expect(branchBar(page)).toContainText("Second question");
    await expect(said(page, "Question 2 about the Kyoto trip")).toBeVisible();
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("open a branch, talk, draft, review, bring back, the AI is told", async ({ page }, info) => {
    await mainFlow(page, info, "embed", 420);
  });

  test("end a branch without bringing it back", async ({ page }, info) => {
    await startConversation(page, info, "embed");
    await openBranch(page, "Used hard drives");
    await branchBar(page).getByRole("button", { name: "不帶回" }).click();
    const dialog = page.getByRole("dialog", { name: "結束支線，不帶回" });
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "結束，不帶回" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "已結束，未帶回。" })).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    await expect(branchBar(page)).toContainText("未帶回");
    await branchBar(page).getByRole("button", { name: "回主線" }).click();
    await expect(path(page).locator('[aria-current="page"]')).toHaveText("主線");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("open a branch, talk, draft, review, bring back, the AI is told", async ({ page }, info) => {
    await mainFlow(page, info, "drawer", 375);
  });

  test("make a branch the main line", async ({ page }, info) => {
    await startConversation(page, info, "drawer", 2);
    await openBranch(page, "Go in spring instead", "另一條路", replies(page).first());
    await turn(page, "Spring it is");
    await branchBar(page).getByRole("button", { name: "升為主線" }).click();
    const dialog = page.getByRole("dialog", { name: "把這條支線升為主線" });
    await expect(dialog.getByRole("figure", { name: "升為主線之後" })).toContainText("原本的主線 #3");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "升為主線" }).click();
    await expect(dialog).toBeHidden();
    await expect(path(page).locator('[aria-current="page"]')).toHaveText("主線");
    await expect(said(page, "Spring it is")).toBeVisible();
    await expect(said(page, "Question 2 about the Kyoto trip")).toHaveCount(0);
    await page.getByRole("button", { name: /從這則岔出的支線/ }).first().tap();
    await expect(page.getByRole("list", { name: "從這則岔出的支線" })).toContainText("原本的主線");
  });
});
