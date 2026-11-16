import { expect, test, type Page } from "@playwright/test";
import { composer, replies, sidePanel, turn } from "./flows";
import { expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { openTab, outlineRow } from "./f5-flows";

/**
 * F11 (10_B16_F11_LEAF_TOPIC_CHAPTERS.md) on the mock: an aside is a leaf
 * (map, outline, no forking inside it); a long first message names the
 * conversation after what it asks; the main line's chapters show as stages
 * in the map and the outline.
 */

const Q = "theme=light&lang=zh-TW";
const path = (page: Page) => page.getByRole("navigation", { name: "路徑" });

test.beforeEach(({}, info) => test.skip(isApi(info), "F11's flows run on the mock's scenario"));

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("① an aside is a leaf: its bar says so, the outline and the map mark it, and nothing inside it forks", async ({ page }) => {
    await page.goto(`/?${Q}&line=okr`);
    await expect(composer(page)).toBeVisible();
    await turn(page, "請介紹豪斯多夫維度與碎形的關係");
    const asked = page.locator("[data-message-id]").filter({ hasText: "請介紹豪斯多夫維度與碎形的關係" }).last();
    await asked.evaluate((node, wanted) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const at = text.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(text, at);
        range.setEnd(text, at + wanted.length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return;
      }
    }, "豪斯多夫維度");
    await page.getByRole("toolbar", { name: "選取的文字" }).getByRole("button", { name: "秒問解釋" }).click();
    // F12 S1: it opens in place under the message; its own view is one press away.
    const inline = page.getByRole("region", { name: "順口問：了解：豪斯多夫維度" });
    await expect(inline).toBeVisible();
    await inline.getByRole("button", { name: "展開完整畫面" }).first().click();
    await expect(path(page)).toContainText("了解：豪斯多夫維度");
    await expect(page.getByText("單輪葉節點（一問一答即結束，不可往下開支線）")).toBeVisible();
    await expect(page.getByRole("region", { name: "回答完了，接下來？" })).toBeVisible({ timeout: 20_000 });
    // Nothing inside the leaf opens a branch.
    await expect(page.getByRole("button", { name: /開支線/ })).toHaveCount(0);
    await openTab(page, "結構");
    const row = outlineRow(page, "了解：豪斯多夫維度");
    await expect(row).toContainText("單輪葉節點");
    await expect(sidePanel(page).getByRole("button", { name: /隱藏順口問/ })).toBeVisible();
    await page.getByRole("radio", { name: "地圖" }).click();
    const leaf = page.getByRole("group", { name: "支線地圖" }).locator("[data-tg-leaf-node]");
    await expect(leaf).toHaveCount(1);
    await expect(leaf).toContainText("單輪葉節點");
    await shoot(page, "F11", "aside-leaf-1440");
  });

  test("② a long first message names the conversation after the question it asks", async ({ page }) => {
    await page.goto(`/?${Q}`);
    const list = page.getByRole("navigation", { name: "對話", exact: true });
    await list.getByRole("button", { name: "新對話" }).first().click();
    await expect(page.getByText("還沒有訊息。在下方輸入第一則。")).toBeVisible();
    await turn(page, "我家有一台 NAS，放了四顆 4TB 的碟，目前用 RAID5。最近看到很多人說 RAID5 重建風險很高。那如果改成 RAID10，容量和安全性要怎麼取捨？");
    await expect(list.getByText("改成 RAID10，容量和安全性要怎麼取捨")).toBeVisible();
    await expect(replies(page)).toHaveCount(1);
    await expect(composer(page)).toHaveValue("");
    await shoot(page, "F11", "topic-title-1440");
  });

  test("③ the main line's chapters: stage pills over the outline and a trunk of stages in the map, each going to its start", async ({ page }) => {
    await page.goto(`/?${Q}&line=nas`);
    await expect(replies(page).first()).toBeVisible();
    await openTab(page, "結構");
    const strip = page.getByRole("group", { name: "主線章節" });
    await expect(strip.getByRole("button")).toHaveCount(4);
    await strip.getByRole("button", { name: /^§2 硬體選擇/ }).click();
    await expect(page.locator('[data-message-id="nas-m16"]')).toBeInViewport();
    await page.getByRole("radio", { name: "地圖" }).click();
    const map = page.getByRole("group", { name: "支線地圖" });
    await expect(map.locator("[data-tg-map-chapter]")).toHaveCount(4);
    await expect(map.getByRole("button", { name: /^§2 硬體選擇/ })).toBeVisible();
    await expectAccessible(page, MODERATE, '[role="group"][aria-label="支線地圖"]');
    await shoot(page, "F11", "map-stages-1440");
    await map.getByRole("button", { name: /^§4 備份策略/ }).click();
    await expect(page.locator('[data-message-id="nas-m39"]')).toBeInViewport();
  });
});
