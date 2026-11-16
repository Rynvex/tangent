import { expect, test } from "@playwright/test";
import { expectAccessible, isApi, shoot } from "./helpers";
import { apiCall, apiTurn, composer, freshConversation, sidePanel } from "./flows";

/**
 * F3 420 嵌入示範頁 and the branch unread divider, on the mock and the
 * reference server: Tangent as a 420px panel in the host theme inside a mock
 * dark developer tool; conversation and branch bar; the outline opens from
 * the top button over the conversation; no map. Entering a branch with
 * unread replies shows "n 則未讀" before the first of them.
 */

test.describe("1440 window, Tangent embedded at 420", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the host frame, the 420 panel in the host theme, the outline over the conversation, no map", async ({ page }, info) => {
    await freshConversation(page, info, "frame=embed&lang=zh-TW");
    const host = page.getByRole("region", { name: "宿主應用程式（示意）" });
    await expect(host).toBeVisible();
    await expect(host).toContainText('data-tg-theme="host"');
    const panel = page.locator("main").first();
    const box = await panel.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(420);
    expect(Math.round(box?.x ?? 0)).toBe(1440 - 420);
    for (const root of await page.locator("[data-tg-root]").all()) await expect(root).toHaveAttribute("data-tg-theme", "host");
    await expect(page.getByRole("navigation", { name: "對話", exact: true })).toHaveCount(0);
    await expectAccessible(page);
    await shoot(page, "F3", `embed-1440-${info.project.name}`);

    await page.getByRole("button", { name: "大綱" }).click();
    const side = sidePanel(page);
    await expect(side).toBeVisible();
    const sideBox = await side.boundingBox();
    expect(Math.round(sideBox?.width ?? 0)).toBe(420);
    await expect(side.getByRole("radio", { name: "大綱" })).toBeVisible();
    await expect(side.getByRole("radio", { name: "地圖" })).toHaveCount(0);
    await shoot(page, "F3", `embed-1440-outline-${info.project.name}`);
    await page.keyboard.press("Escape");
    await expect(side).toBeHidden();
    await expect(composer(page)).toBeVisible();
  });
});

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("entering a branch with unread replies shows the divider before the first of them", async ({ page }, info) => {
    let branchId = "nas-b3";
    if (isApi(info)) {
      const root = await apiCall<{ id: string }>(page, "post", "/lines", { title: "Unread e2e" });
      await apiTurn(page, root.id, "Where to stay in Kyoto?");
      const messages = await apiCall<{ messages: Array<{ id: string; role: string }> }>(page, "get", `/lines/${root.id}/messages`);
      const anchor = messages.messages.filter((message) => message.role === "assistant").at(-1)?.id ?? "";
      branchId = (await apiCall<{ line: { id: string } }>(page, "post", `/lines/${root.id}/branches`, { anchorMessageId: anchor, purpose: "Ryokan or hotel", kind: "investigate" })).line.id;
      await apiTurn(page, branchId, "First question in the branch");
      await apiTurn(page, branchId, "Second question in the branch");
      await apiTurn(page, branchId, "Third question in the branch");
      // The UI read the branch up to the first reply; two came later.
      await apiCall(page, "post", `/lines/${branchId}/read`);
      await apiTurn(page, branchId, "Fourth question in the branch");
      await apiTurn(page, branchId, "Fifth question in the branch");
    }
    await page.goto(`/?theme=light&lang=zh-TW&line=${branchId}`);
    const divider = page.getByRole("separator", { name: "2 則未讀" });
    await expect(divider).toBeVisible();
    // Right before the first unread reply, and it stays after the branch is marked read.
    const row = divider.locator("xpath=ancestor::li[@data-message-id]");
    await expect(row.locator("article[data-tg-message]")).toContainText(isApi(info) ? "Fourth question in the branch" : "WD Red Plus 與 IronWolf");
    await expect(page.getByRole("list", { name: "訊息" }).locator("li").filter({ has: divider })).toHaveCount(1);
    await page.waitForTimeout(500);
    await expect(divider).toBeVisible();
    await shoot(page, "F3", `unread-1440-${info.project.name}`);
  });
});
