import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { apiCall, apiTurn, composer, E2E_GOAL, freshConversation, replies, sidePanel, turn } from "./flows";
import { backToMain, branchBar, endedBranch, openBranch, openTab, outlineRow } from "./f5-flows";

/**
 * F5 phase 3 (B9 phase C and B9.1) on the mock and the reference server
 * (fake runner, `group:suggest`): groups made from a multi-selection in the
 * outline (shared summary, the map's frame and XMind bracket), combining
 * open siblings (已合併到…), AI's group suggestion reviewed from 待處理 with a
 * choice per conflict, a relation's note changed on the map, a goal proposal
 * that fails (job.failed) — at 1440, 420 (embedded) and 375 (phone) — and
 * none of it with the group feature off.
 */

const Q = "theme=light&lang=zh-TW";
const groupDialog = (page: Page) => page.getByRole("dialog", { name: "建立群組" });
const combineDialog = (page: Page) => page.getByRole("dialog", { name: "合併成一條支線" });

/** Two open sibling branches: the mock's NAS ones, or two made through the API. */
async function openSiblings(page: Page, info: TestInfo, query: string): Promise<{ root: string; a: string; b: string; child?: string }> {
  if (!isApi(info)) {
    await page.goto(`/?${query}&line=nas`);
    await expect(composer(page)).toBeVisible();
    return { root: "nas", a: "4TB 與 8TB 硬碟的每 TB 成本與保固", b: "改用雲端備份（Backblaze B2），NAS 只做本地快取" };
  }
  const root = (await apiCall<{ id: string }>(page, "post", "/lines", { title: "F5 combine" }, info)).id;
  if (info.project.name === "api") await apiCall(page, "put", `/lines/${root}/goal`, { text: E2E_GOAL }, info);
  await apiTurn(page, root, "Rail or bus around Kyoto?", info);
  const anchor = (await apiCall<{ messages: Array<{ id: string }> }>(page, "get", `/lines/${root}/messages`, undefined, info)).messages.at(-1)!.id;
  const [rail] = await Promise.all(["Rail passes", "Bus passes"].map((purpose) => apiCall<{ line: { id: string } }>(page, "post", `/lines/${root}/branches`, { anchorMessageId: anchor, purpose, kind: "investigate" }, info)));
  // An open child of one of them: combining moves it onto the new branch (B9.1).
  await apiTurn(page, rail!.line.id, "Which pass?", info);
  const fork = (await apiCall<{ messages: Array<{ id: string }> }>(page, "get", `/lines/${rail!.line.id}/messages`, undefined, info)).messages.at(-1)!.id;
  await apiCall(page, "post", `/lines/${rail!.line.id}/branches`, { anchorMessageId: fork, purpose: "Nara day pass", kind: "investigate" }, info);
  await page.goto(`/?${query}&line=${root}`);
  await expect(replies(page)).toHaveCount(1);
  return { root, a: "Rail passes", b: "Bus passes", child: "Nara day pass" };
}

/** Two ended branches with an ending each: the mock's NAS ones, or two made and discarded (with a leaf) through the API. */
async function endedPair(page: Page, info: TestInfo, query: string): Promise<{ a: string; b: string }> {
  if (!isApi(info)) {
    await page.goto(`/?${query}&line=nas`);
    await expect(composer(page)).toBeVisible();
    return { a: "用舊筆電當 NAS", b: "二手企業碟可不可靠" };
  }
  const root = (await apiCall<{ id: string }>(page, "post", "/lines", { title: "F5 group" }, info)).id;
  if (info.project.name === "api") await apiCall(page, "put", `/lines/${root}/goal`, { text: E2E_GOAL }, info);
  await apiTurn(page, root, "Which drives for the NAS?", info);
  const anchor = (await apiCall<{ messages: Array<{ id: string }> }>(page, "get", `/lines/${root}/messages`, undefined, info)).messages.at(-1)!.id;
  for (const [purpose, line] of [["Used drives", "保固太短"], ["New 8 TB drives", "太貴"]] as const) {
    const made = await apiCall<{ line: { id: string } }>(page, "post", `/lines/${root}/branches`, { anchorMessageId: anchor, purpose, kind: "investigate" }, info);
    await apiCall(page, "post", `/lines/${made.line.id}/branch/discard`, { leaf: { kind: "dead_end", line } }, info);
  }
  await page.goto(`/?${query}&line=${root}`);
  await expect(replies(page)).toHaveCount(1);
  return { a: "Used drives", b: "New 8 TB drives" };
}

async function selectRows(page: Page, ...purposes: string[]): Promise<void> {
  for (const purpose of purposes) await outlineRow(page, purpose).click({ modifiers: ["Shift"] });
}

test.describe("1440 desktop: groups and combining (C2, phase 3)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(info.project.name === "api-core", "the core-only server has no groups"));

  test("multi-select in the outline → 建立群組: the shared summary, the map's frame and bracket", async ({ page }, info) => {
    test.slow();
    const { a, b } = await endedPair(page, info, Q);
    await openTab(page, "結構");
    await selectRows(page, a, b);
    await sidePanel(page).getByRole("button", { name: "建立群組" }).click();
    const dialog = groupDialog(page);
    await dialog.getByRole("textbox", { name: "群組名稱" }).fill("硬碟選購");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await dialog.getByRole("button", { name: "建立群組" }).click();
    await expect(dialog).toBeHidden();
    const group = sidePanel(page).getByRole("article", { name: "群組：硬碟選購" });
    await expect(group).toContainText("These branches settle one question together (fake runner).", { timeout: 20_000 });
    await expect(group.getByRole("button", { name: new RegExp(`^前往「.*${a}」`) })).toBeVisible();

    await sidePanel(page).getByRole("radio", { name: "地圖" }).click();
    const map = sidePanel(page).getByRole("group", { name: "支線地圖" });
    await expect(sidePanel(page).getByRole("group", { name: "地圖圖層" }).getByRole("button", { name: "群組" })).toHaveAttribute("aria-pressed", "true");
    await expect(map.locator("[data-tg-group-frame]")).toHaveCount(1);
    await expect(map.locator("[data-tg-group-bracket]")).toHaveCount(1);
    await expect(map.getByRole("article", { name: "群組・硬碟選購" })).toContainText("fake runner");
    await expectAccessible(page, MODERATE, '[aria-label="側欄"]');
    // The picture: the map at full width with only the group layer, fitted (0).
    await sidePanel(page).getByRole("button", { name: "全幅" }).click();
    const overlay = page.getByRole("region", { name: "支線地圖" });
    await overlay.getByRole("group", { name: "地圖圖層" }).getByRole("button", { name: "關聯" }).click();
    await expect(overlay.getByRole("article", { name: "群組・硬碟選購" })).toBeVisible();
    await overlay.getByRole("group", { name: "支線地圖" }).focus();
    await page.keyboard.press("0");
    await shoot(page, "F5", `group-map-1440-${info.project.name}`);
  });

  test("合併: open siblings become one branch; the old ones say 已合併到… and lead there", async ({ page }, info) => {
    const { a, b, child } = await openSiblings(page, info, Q);
    await openTab(page, "結構");
    await selectRows(page, a, b);
    await sidePanel(page).getByRole("button", { name: "合併成一條支線" }).click();
    const dialog = combineDialog(page);
    await expect(dialog).toContainText("原本的支線會結束，標示「已合併到…」");
    await dialog.getByRole("textbox", { name: /新支線的目的/ }).fill("Pick the pass");
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F5", `combine-dialog-1440-${info.project.name}`);
    await dialog.getByRole("button", { name: "合併" }).click();
    await expect(dialog).toBeHidden();
    await expect(branchBar(page)).toContainText("Pick the pass");
    await expect(outlineRow(page, a)).toContainText("已合併到「Pick the pass」");
    if (child) {
      // B9.1: the open child now hangs under the new branch, one level below it.
      await expect(outlineRow(page, child)).toHaveAttribute("aria-level", "3");
      const rows = await sidePanel(page).getByRole("treeitem").allInnerTexts();
      const at = (text: string) => rows.findIndex((row) => row.startsWith(text));
      expect(at(child)).toBe(at("Pick the pass") + 1);
    }
    await outlineRow(page, a).click();
    await expect(page.getByText("已合併到「Pick the pass」。")).toBeVisible();
    await page.getByRole("button", { name: "前往「Pick the pass」" }).click();
    await expect(branchBar(page)).toContainText("Pick the pass");
  });

  test("AI's group suggestion from 待處理: reviewed, each conflict chosen by keyboard, never popping up", async ({ page }, info) => {
    test.slow();
    await freshConversation(page, info, Q, 1, "F5 group suggestion");
    for (const [purpose, reason] of [["Disk A", "太吵"], ["Disk B", "太貴"], ["Disk C", "保固太短"]]) await endedBranch(page, purpose!, reason!);
    await expect(composer(page)).toBeVisible();
    await openTab(page, "待處理");
    const card = sidePanel(page).getByRole("article", { name: "建議：群組" }).filter({ hasText: "Ended together (fake runner)" }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("1 個矛盾待決定");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await card.getByRole("button", { name: "檢視…" }).click();
    const dialog = groupDialog(page);
    await expect(dialog.getByRole("textbox", { name: "群組名稱" })).toHaveValue("Ended together (fake runner)");
    const conflict = dialog.getByRole("radiogroup", { name: /矛盾 1/ });
    await dialog.getByRole("button", { name: "建立群組" }).click();
    await expect(dialog.getByRole("alert")).toContainText("每個矛盾都要選一個");
    await conflict.getByRole("radio").first().focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(conflict.getByRole("radio", { name: /都保留/ })).toBeChecked();
    await expectAccessible(page, MODERATE, '[role="dialog"]');
    await shoot(page, "F5", `group-suggestion-1440-${info.project.name}`);
    await dialog.getByRole("button", { name: "建立群組" }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText("已接受");
    await openTab(page, "紀要");
    await expect(sidePanel(page).getByText(/the first one says yes/).first()).toBeVisible();
    await openTab(page, "結構");
    await expect(sidePanel(page).getByRole("article", { name: "群組：Ended together (fake runner)" })).toBeVisible();
  });

  test("a relation is made on drop, then its note changed with 改說明", async ({ page }, info) => {
    await freshConversation(page, info, Q, 1, "F5 relation note");
    await openBranch(page, "Rail passes");
    await backToMain(page);
    await openBranch(page, "Hotel prices");
    await backToMain(page);
    await openTab(page, "結構");
    await sidePanel(page).getByRole("radio", { name: "地圖" }).click();
    const map = sidePanel(page).getByRole("group", { name: "支線地圖" });
    await map.getByRole("button", { name: /^Rail passes/ }).focus();
    await page.keyboard.press("r");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    // Made on drop: Esc leaves it without a note.
    await expect(map.getByRole("textbox", { name: "這兩個節點有什麼關係" })).toBeFocused();
    await page.keyboard.press("Escape");
    const pill = map.getByRole("button", { name: /^關聯 / });
    await expect(pill).toHaveCount(1);
    await pill.click();
    await map.getByRole("button", { name: "改說明" }).click();
    const note = map.getByRole("textbox", { name: "這兩個節點有什麼關係" });
    await expect(note).toBeFocused();
    await note.fill("同一個週末");
    await note.press("Enter");
    await expect(map.getByRole("button", { name: /^關聯 .*同一個週末$/ })).toBeVisible();
    if (!isApi(info)) return;
    await page.reload();
    await openTab(page, "結構");
    await expect(sidePanel(page).getByRole("region", { name: /^關聯/ }).getByText("同一個週末")).toBeVisible();
  });

  test("a goal proposal that fails says so (job.failed) and stops waiting", async ({ page }, info) => {
    if (isApi(info)) {
      const line = await apiCall<{ id: string }>(page, "post", "/lines", { title: "F5 goal failure" }, info);
      await apiTurn(page, line.id, "[fake:job-error] Where should we stay?", info);
      await page.goto(`/?${Q}&line=${line.id}`);
      await expect(replies(page)).toHaveCount(1);
    } else {
      await page.goto(`/?${Q}&line=rust`);
      await expect(composer(page)).toBeVisible();
      await turn(page, "[fake:job-error] 所有權是什麼？");
    }
    await page.getByRole("button", { name: /^設定目標/ }).click();
    const editor = page.getByRole("dialog", { name: "目標" });
    await editor.getByRole("button", { name: "讓 AI 提案" }).click();
    await expect(editor.getByRole("alert")).toContainText("AI 沒能提出目標（", { timeout: 20_000 });
    await expect(editor.getByText("AI 正在提出目標…")).toHaveCount(0);
    await expect(editor.getByRole("button", { name: "讓 AI 提案" })).toBeEnabled();
  });
});

test.describe("1440, the group feature off", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no group list, no 建立群組 or 合併 for a selection, no 群組 layer", async ({ page }, info) => {
    test.skip(info.project.name === "api", "the api server runs groups on; api-core and the mock's C1 set do not");
    const { a } = await openSiblings(page, info, info.project.name === "mock" ? `${Q}&features=c1` : Q);
    // With no P1 feature the side panel is the structure alone (no tabs).
    await expect(sidePanel(page).getByRole("tree", { name: "支線大綱" })).toBeVisible();
    // R9 G2: nothing to do with a selection, so no 多選 at all; Shift-click just opens the line.
    await expect(sidePanel(page).getByRole("button", { name: "多選" })).toHaveCount(0);
    await outlineRow(page, a).click({ modifiers: ["Shift"] });
    await expect(sidePanel(page).getByRole("tree", { name: "支線大綱" })).not.toHaveAttribute("aria-multiselectable", "true");
    await expect(sidePanel(page).getByRole("button", { name: /建立群組|合併成一條支線/ })).toHaveCount(0);
    await expect(sidePanel(page).getByRole("heading", { name: /^群組/ })).toHaveCount(0);
    await sidePanel(page).getByRole("radio", { name: "地圖" }).click();
    await expect(sidePanel(page).getByRole("button", { name: "群組" })).toHaveCount(0);
    await expect(sidePanel(page).getByRole("button", { name: "多選" })).toHaveCount(0);
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("combine from the outline's 多選: the dialog fits the frame", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no groups on the core-only server");
    const { a, b } = await openSiblings(page, info, "frame=embed&lang=zh-TW");
    await page.getByRole("button", { name: "大綱" }).click();
    await page.getByRole("button", { name: "多選" }).click();
    await outlineRow(page, a).click();
    await outlineRow(page, b).click();
    await page.getByRole("button", { name: "合併成一條支線" }).click();
    const dialog = combineDialog(page);
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(420);
    await shoot(page, "F5", `combine-420-${info.project.name}`);
    await expectAccessible(page);
    await dialog.getByRole("textbox", { name: /新支線的目的/ }).fill("Pick one");
    await dialog.getByRole("button", { name: "合併" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("navigation", { name: "路徑" })).toContainText("Pick one");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("a group from the phone outline by touch: 多選, two rows, 建立群組", async ({ page }, info) => {
    test.skip(info.project.name === "api-core", "no groups on the core-only server");
    const { a, b } = await endedPair(page, info, Q);
    await page.getByRole("button", { name: "大綱" }).tap();
    await openTab(page, "結構");
    const multi = sidePanel(page).getByRole("button", { name: "多選" });
    expect((await multi.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await multi.tap();
    await outlineRow(page, a).tap();
    await outlineRow(page, b).tap();
    await sidePanel(page).getByRole("button", { name: "建立群組" }).tap();
    const dialog = groupDialog(page);
    await dialog.getByRole("textbox", { name: "群組名稱" }).fill("硬碟");
    await shoot(page, "F5", `group-375-${info.project.name}`);
    await expectAccessible(page);
    await dialog.getByRole("button", { name: "建立群組" }).tap();
    await expect(dialog).toBeHidden();
    await expect(sidePanel(page).getByRole("article", { name: "群組：硬碟" })).toBeVisible();
  });
});
