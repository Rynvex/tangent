import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { API, expectAccessible, MODERATE, shoot, messageAction } from "./helpers";
import { apiCall, composer, freshConversation, replies, sidePanel, turn } from "./flows";

/**
 * F4 phase 2 (B8 phase B) on the mock and the reference server (its default
 * features: spinoff and rebalance in suggest mode): spinning a branch off
 * (「已獨立 →」 on the source, 「來自：…」 on the new conversation, both
 * links followed), a fresh conversation from a message, and the tree-balance
 * hint after enough branch turns with its three answers (維持 / 獨立 /
 * 升為主線), the same suggestion in 待處理, no popups and no focus taken.
 */

const branchBar = (page: Page) => page.getByRole("region", { name: "支線資訊" });
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });
const hint = (page: Page) => branchBar(page).getByRole("group", { name: "樹平衡" });

async function openBranch(page: Page, purpose: string, kind: "查證" | "另一條路" = "另一條路"): Promise<void> {
  const from = replies(page).last();
  await from.hover();
  await messageAction(from, "從這則開支線");
  const dialog = page.getByRole("dialog", { name: "開支線" });
  await dialog.getByRole("textbox", { name: /目的/ }).fill(purpose);
  await dialog.getByRole("radio", { name: new RegExp(kind) }).click();
  await dialog.getByRole("button", { name: "開支線" }).click();
  await expect(dialog).toBeHidden();
  await expect(branchBar(page)).toContainText(purpose);
}

/** Enough replies in the branch for the tree-balance suggestion: the tree's last five replies all here. */
async function busyBranch(page: Page, purpose: string): Promise<void> {
  await openBranch(page, purpose);
  for (let i = 1; i <= 5; i += 1) await turn(page, `${purpose}, step ${i}`);
}

const skipCore = (info: TestInfo) => test.skip(info.project.name === "api-core", "the core-only server has no spinoff or tree balance");

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => skipCore(info));

  test("spin a branch off: the source keeps 「已獨立 →」, the new conversation says where it came from", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 spinoff source");
    await openBranch(page, "Day trips from Kyoto", "查證");
    await turn(page, "Nara or Uji?");
    await branchBar(page).getByRole("button", { name: "獨立成新對話" }).click();
    const dialog = page.getByRole("dialog", { name: "獨立成新對話" });
    await expect(dialog.getByRole("radio", { name: /整條支線變成新對話/ })).toHaveAttribute("aria-checked", "true");
    // B8.2: the server's own capsule, its tokens, and its text on demand.
    const capsule = dialog.getByRole("group", { name: /新對話一開始會帶/ });
    await expect(capsule).toContainText(/≈ \d+ token/);
    await capsule.getByRole("button", { name: "看起始膠囊的內容" }).click();
    await expect(capsule.locator("pre")).toContainText(/spun off/);
    await dialog.getByRole("checkbox", { name: "複製目前的紀要到新對話" }).click();
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F4", `spinoff-dialog-1440-${info.project.name}`);
    await dialog.getByRole("button", { name: "建立新對話" }).click();
    await expect(dialog).toBeHidden();

    // The new conversation: a main line of its own, pointing back.
    await expect(path(page).locator('[aria-current="page"]')).toHaveText("主線");
    const origin = page.getByRole("button", { name: /^來自：/ });
    await expect(origin).toBeVisible();
    await expect(page.getByText("Nara or Uji?", { exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: /^Day trips from Kyoto/ })).toBeVisible();
    await shoot(page, "F4", `spinoff-new-1440-${info.project.name}`);
    await expectAccessible(page);

    // Back to the source: its marker leads forward again.
    await origin.click();
    const marker = page.getByRole("button", { name: "已獨立 →「Day trips from Kyoto」" });
    await expect(marker).toBeVisible();
    await expect(sidePanel(page).getByRole("treeitem", { name: /^Day trips from Kyoto/ })).toHaveCount(0);
    await marker.click();
    await expect(page.getByRole("button", { name: /^來自：/ })).toBeVisible();
  });

  test("start a fresh conversation from a reply", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 2, "F4 fresh source");
    const first = replies(page).first();
    await first.hover();
    await messageAction(first, "從這裡開新對話");
    const dialog = page.getByRole("dialog", { name: "獨立成新對話" });
    await expect(dialog.getByRole("radiogroup", { name: "方式" })).toHaveCount(0);
    await expect(dialog.getByRole("group", { name: /新對話一開始會帶/ })).toContainText(/≈ \d+ token/);
    await dialog.getByRole("textbox", { name: "新對話的標題" }).fill("Kyoto, the short version");
    await dialog.getByRole("button", { name: "建立新對話" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /^來自：/ })).toBeVisible();
    await expect(page.getByText("還沒有訊息。在下方輸入第一則。")).toBeVisible();
  });

  test("a deleted spinoff is named, not linked, on both sides (B8.2 available)", async ({ page }, info) => {
    test.skip(!info.project.name.startsWith("api"), "deleting a conversation goes through the server here");
    const sourceId = await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 gone source");
    const first = replies(page).first();
    await first.hover();
    await messageAction(first, "從這裡開新對話");
    const dialog = page.getByRole("dialog", { name: "獨立成新對話" });
    await dialog.getByRole("textbox", { name: "新對話的標題" }).fill("Soon gone");
    await dialog.getByRole("button", { name: "建立新對話" }).click();
    await expect(page.getByRole("button", { name: /^來自：F4 gone source/ })).toBeVisible();
    const lines = await apiCall<{ lines: Array<{ id: string; title: string }> }>(page, "get", "/lines", undefined, info);
    const gone = lines.lines.find((line) => line.title === "Soon gone")!;
    const removed = await page.request.delete(`${API.url()}/lines/${gone.id}`, { headers: { Authorization: `Bearer ${API.token()}` } });
    expect(removed.ok()).toBe(true);
    await page.goto(`/?theme=light&lang=zh-TW&line=${sourceId}`);
    await expect(page.getByText("已獨立 →「Soon gone」（對話已刪除）")).toBeVisible();
    await expect(page.getByRole("button", { name: /已獨立 →「Soon gone」/ })).toHaveCount(0);
  });

  test("tree balance: the hint comes without taking focus, 維持 keeps it away, 獨立 spins the branch off", async ({ page }, info) => {
    // A dozen turns against the real server: near 30 s when the whole suite runs on 8 workers (F5: seen at 29–31 s).
    test.slow();
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 balance");
    await busyBranch(page, "Cloud only");
    await expect(hint(page)).toContainText("最近 5 則回覆都在這條支線。", { timeout: 15_000 });
    await expect(composer(page)).toBeFocused();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectAccessible(page, MODERATE, '[aria-label="支線資訊"]');
    await shoot(page, "F4", `rebalance-1440-${info.project.name}`);
    // The same suggestion in 待處理.
    await sidePanel(page).getByRole("tab", { name: /^待處理/ }).click();
    await expect(sidePanel(page).getByRole("article", { name: "建議：樹平衡" })).toContainText("關於：另一條路・Cloud only");

    await hint(page).getByRole("button", { name: "維持" }).click();
    await expect(hint(page)).toHaveCount(0);
    await turn(page, "Cloud only, one more");
    await expect(hint(page)).toHaveCount(0);

    // Another busy branch: 獨立 through the suggestion.
    await branchBar(page).getByRole("button", { name: "回主線" }).click();
    await busyBranch(page, "Second disk set");
    await hint(page).getByRole("button", { name: "獨立" }).click();
    const dialog = page.getByRole("dialog", { name: "獨立成新對話" });
    await dialog.getByRole("button", { name: "建立新對話" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /^來自：/ })).toBeVisible();
  });

  test("tree balance: 升為主線 through the suggestion", async ({ page }, info) => {
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 balance promote");
    await busyBranch(page, "Spring instead");
    await hint(page).getByRole("button", { name: "升為主線" }).click();
    const dialog = page.getByRole("dialog", { name: "把這條支線升為主線" });
    await dialog.getByRole("button", { name: "升為主線" }).click();
    await expect(dialog).toBeHidden();
    await expect(path(page).locator('[aria-current="page"]')).toHaveText("主線");
    await expect(page.getByText("Spring instead, step 5", { exact: true })).toBeVisible();
  });
});

test.describe("1440, features off", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no spinoff entries and no tree balance", async ({ page }, info) => {
    test.skip(info.project.name === "api", "the api server has them on; api-core and the mock's C1 set do not");
    if (info.project.name === "mock") await page.goto("/?theme=light&lang=zh-TW&features=c1&line=nas");
    else await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 off");
    const last = replies(page).last();
    await expect(last).toBeVisible();
    await last.hover();
    await expect(last.getByRole("button", { name: "從這裡開新對話" })).toHaveCount(0);
    if (info.project.name !== "mock") return;
    await sidePanel(page).getByRole("treeitem", { name: /^4TB 與 8TB/ }).click();
    await expect(branchBar(page).getByRole("button", { name: "獨立成新對話" })).toHaveCount(0);
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("a fresh conversation from a reply, full-screen dialog", async ({ page }, info) => {
    skipCore(info);
    await freshConversation(page, info, "theme=light&lang=zh-TW", 1, "F4 phone spinoff");
    const reply = replies(page).last();
    await messageAction(reply, "從這裡開新對話", { tap: true });
    const dialog = page.getByRole("dialog", { name: "獨立成新對話" });
    await expect(dialog).toBeVisible();
    await expectAccessible(page);
    await shoot(page, "F4", `spinoff-375-${info.project.name}`);
    await dialog.getByRole("button", { name: "建立新對話" }).tap();
    await expect(page.getByRole("button", { name: /^來自：/ })).toBeVisible();
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the tree-balance hint fits the narrow branch bar", async ({ page }, info) => {
    skipCore(info);
    await freshConversation(page, info, "frame=embed&lang=zh-TW", 1, "F4 embed balance");
    await busyBranch(page, "Narrow");
    await expect(hint(page)).toBeVisible({ timeout: 15_000 });
    const box = await hint(page).boundingBox();
    expect(box?.width).toBeLessThanOrEqual(420);
    await shoot(page, "F4", `rebalance-420-${info.project.name}`);
    await expectAccessible(page);
  });
});
