import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { apiCall, apiTurn } from "./flows";

/**
 * F3 conversation search (DESIGN §12 F3, B5 `GET /search`): with the
 * `search` feature on (the mock's full set, the reference server's default)
 * the list's search box asks the server and shows grouped hits with the
 * matched text marked; ↑ ↓ Enter open a hit at its message; Esc clears;
 * 包含封存 (kept per browser) adds the archived conversations. With
 * the feature off (`api-core`, the mock's C1 set) the local title search stays.
 */

const box = (page: Page) => page.getByRole("navigation", { name: "對話", exact: true }).getByRole("combobox", { name: "搜尋對話與支線" });

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("server search: grouped hits, marks, keyboard, opens the message", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "the core server has no search");
    // A word only one message holds.
    let word = "rclone";
    if (isApi(info)) {
      word = `kumquat${Date.now() % 100000}`;
      const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "Search e2e" });
      await apiTurn(page, line.id, "First question about Kyoto");
      await apiTurn(page, line.id, `Where can I buy ${word} jam?`);
      await apiTurn(page, line.id, "Third question about Nara");
    }
    await page.goto("/?theme=light&lang=zh-TW");
    await box(page).fill("z");
    await expect(page.getByText("至少輸入 2 個字。")).toBeVisible();
    await box(page).fill(word);
    const results = page.getByRole("listbox", { name: "搜尋結果" });
    await expect(results).toBeVisible({ timeout: 10_000 });
    const messages = results.getByRole("group", { name: "訊息" });
    await expect(messages.getByRole("option").first()).toBeVisible();
    await expect(messages.locator("mark").first()).toHaveText(new RegExp(`^${word}$`, "i"));
    await shoot(page, "F3", `search-1440-${info.project.name}`);
    await expectAccessible(page, MODERATE, '[aria-label="對話"]');

    // ↓ to the first message hit, Enter opens its line at that message.
    const first = messages.getByRole("option").first();
    const messageId = await first.getAttribute("data-message-id");
    const options = results.getByRole("option");
    const index = await options.evaluateAll((all, id) => all.findIndex((option) => option.getAttribute("data-message-id") === id), messageId);
    for (let i = 0; i <= index; i += 1) await box(page).press("ArrowDown");
    await expect(first).toHaveAttribute("aria-selected", "true");
    await box(page).press("Enter");
    const row = page.getByRole("list", { name: "訊息" }).locator(`li[data-message-id="${messageId}"]`);
    await expect(row).toBeInViewport();
    await expect(row).toContainText(new RegExp(word, "i"));

    await box(page).press("Escape");
    await expect(box(page)).toHaveValue("");
    await expect(results).toBeHidden();
  });

  test("包含封存 adds the archived conversations, labelled, and stays on after a reload", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "the core server has no search");
    let word = "Proxmox";
    if (isApi(info)) {
      word = `quince${Date.now() % 100000}`;
      const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: `Archived ${word} plans` });
      await apiTurn(page, line.id, "A question to archive");
      await apiCall(page, "post", `/lines/${line.id}/archive`);
    }
    await page.goto("/?theme=light&lang=zh-TW");
    await box(page).fill(word);
    await expect(page.getByText(`沒有符合「${word}」的結果。`)).toBeVisible({ timeout: 10_000 });
    const toggle = page.getByRole("button", { name: "包含封存" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const hit = page.getByRole("listbox", { name: "搜尋結果" }).getByRole("group", { name: "對話標題" }).getByRole("option").first();
    await expect(hit).toContainText(word);
    await expect(hit.getByText("已封存")).toBeVisible();
    await expect(box(page)).toBeFocused();
    await expectAccessible(page, MODERATE, '[aria-label="對話"]');
    await shoot(page, "F3", `search-archived-1440-${info.project.name}`);

    await page.reload();
    await box(page).fill(word);
    await expect(page.getByRole("button", { name: "包含封存" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("listbox", { name: "搜尋結果" }).getByText("已封存").first()).toBeVisible({ timeout: 10_000 });
  });

  test("search off: the local title search stays", async ({ page }, info) => {
    test.skip(info.project.name === "api", "the default server searches");
    const title = info.project.name === "mock" ? "家用 NAS" : `Local search ${Date.now() % 1_000_000}`;
    if (info.project.name === "api-core") await apiCall(page, "post", "/lines", { title }, info);
    await page.goto(`/?theme=light&lang=zh-TW${info.project.name === "mock" ? "&features=c1" : ""}`);
    const search = page.getByRole("searchbox", { name: "搜尋對話與支線" });
    await search.fill(title);
    const section = page.getByRole("region", { name: "搜尋結果" });
    await expect(section.getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await search.press("Escape");
    await expect(search).toHaveValue("");
  });
});
