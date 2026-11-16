import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { API, expectAccessible, isApi, MODERATE, shoot } from "./helpers";
import { sidePanel } from "./flows";

/**
 * F2 phase 2, the 結構 side panel, against the mock (scenario 1) and the
 * reference server (a tree built through the API): the outline's keyboard
 * spec, the map (zoom, fit, full width, entering a branch), chapters
 * (milestone, divider, jump) and the three exports.
 */

interface Tree {
  root: string;
  rootTitle: string;
  /** A branch with a sub-branch under it. */
  parent: { id: string; purpose: string };
  child: { id: string; purpose: string };
  other: { id: string; purpose: string };
}

const MOCK_TREE: Tree = {
  root: "nas",
  rootTitle: "家用 NAS 與備份策略",
  parent: { id: "nas-b1", purpose: "ZFS mirror 與 Btrfs RAID1 在單碟故障時的差異" },
  child: { id: "nas-b1a", purpose: "scrub 多久跑一次？" },
  other: { id: "nas-b2", purpose: "改用雲端備份（Backblaze B2），NAS 只做本地快取" },
};

const auth = () => ({ Authorization: `Bearer ${API.token()}` });

async function call<T>(request: APIRequestContext, method: "get" | "post", path: string, data?: unknown): Promise<T> {
  const response = await request[method](`${API.url()}${path}`, { headers: auth(), ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/** One finished turn on a line; returns the reply's id. */
async function turn(request: APIRequestContext, lineId: string, content: string): Promise<string> {
  const sent = await call<{ turnId: string }>(request, "post", `/lines/${lineId}/messages`, { content });
  await expect.poll(async () => (await call<{ status: string }>(request, "get", `/lines/${lineId}`)).status, { timeout: 15_000 }).toBe("idle");
  return sent.turnId;
}

/** A conversation with two branches on the main line and a sub-branch, built through the API. */
async function apiTree(request: APIRequestContext): Promise<Tree> {
  const rootTitle = "Structure e2e";
  const root = (await call<{ id: string }>(request, "post", "/lines", { title: rootTitle })).id;
  const first = await turn(request, root, "First question about the trip");
  await turn(request, root, "Second question about the trip");
  const branch = async (lineId: string, anchor: string, purpose: string) =>
    (await call<{ line: { id: string } }>(request, "post", `/lines/${lineId}/branches`, { anchorMessageId: anchor, purpose, kind: "investigate" })).line.id;
  const parent = { id: await branch(root, first, "Alpha rail passes"), purpose: "Alpha rail passes" };
  const other = { id: await branch(root, first, "Cedar hotels"), purpose: "Cedar hotels" };
  const reply = await turn(request, parent.id, "Which pass?");
  const child = { id: await branch(parent.id, reply, "Alpha one Nara"), purpose: "Alpha one Nara" };
  return { root, rootTitle, parent, child, other };
}

async function open(page: Page, info: TestInfo, query = "theme=light&lang=zh-TW"): Promise<Tree> {
  const tree = isApi(info) ? await apiTree(page.request) : MOCK_TREE;
  await page.goto(`/?${query}&line=${tree.root}`);
  await expect(page.getByRole("tree", { name: "支線大綱" })).toBeVisible();
  return tree;
}

const outline = (page: Page) => page.getByRole("tree", { name: "支線大綱" });
const row = (page: Page, title: string) => outline(page).getByRole("treeitem", { name: new RegExp(`^${title.replace(/[?()]/g, "\\$&")}(，|,|$)`) });
const current = (page: Page) => page.getByRole("navigation", { name: "路徑" }).locator('[aria-current="page"]');

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the outline follows the keyboard spec", async ({ page }, info) => {
    const tree = await open(page, info);
    // Scenario 1's sub-branch is an aside, which the outline shows as a leaf by default (F11 §1).
    if (!isApi(info)) await expect(page.getByRole("button", { name: "隱藏順口問（1）" })).toBeVisible();
    const main = row(page, "主線");
    await expect(main).toHaveAttribute("aria-current", "location");
    await expect(main).toHaveAttribute("tabindex", "0");
    await expectAccessible(page, MODERATE, '[role="tree"]');
    await main.focus();
    await page.keyboard.press("End");
    await expect(row(page, tree.other.purpose)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(main).toBeFocused();
    // Typeahead finds the parent; → opens it (when folded) or goes to its first child; ← goes back up.
    await page.keyboard.type(tree.parent.purpose.slice(0, 1));
    await expect(row(page, tree.parent.purpose)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, tree.parent.purpose)).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, tree.child.purpose)).toHaveCount(0);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(row(page, tree.child.purpose)).toBeFocused();
    await expect(row(page, tree.child.purpose)).toHaveAttribute("aria-level", "3");
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, tree.parent.purpose)).toBeFocused();
    // Enter goes into the branch and keeps focus in the outline.
    await page.keyboard.press("Enter");
    await expect(current(page)).toContainText(tree.parent.purpose);
    await expect(row(page, tree.parent.purpose)).toBeFocused();
    await expect(row(page, tree.parent.purpose)).toHaveAttribute("aria-current", "location");
    // Several: Shift+↓, then Esc clears; Esc again returns to the composer (when the line has one).
    await page.keyboard.press("Shift+ArrowDown");
    await expect(outline(page)).toHaveAttribute("aria-multiselectable", "true");
    // Asides are never selected: scenario 1's sub-branch is one.
    await expect(page.getByText(isApi(info) ? "已選 2 條" : "已選 1 條")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(outline(page)).not.toHaveAttribute("aria-multiselectable", "true");
    await page.keyboard.press("Escape");
    // Scenario 1's parent was brought back, so its line is read-only and has no composer: focus stays in the outline.
    if (isApi(info)) await expect(page.getByRole("textbox", { name: "訊息" })).toBeFocused();
    else await expect(outline(page).locator(":focus")).toHaveCount(1);
    await shoot(page, "F2", `outline-1440-${info.project.name}`);
  });

  test("the map zooms, fits, opens full width and enters a branch", async ({ page }, info) => {
    const tree = await open(page, info);
    await page.keyboard.press("ControlOrMeta+Shift+m");
    const map = page.getByRole("group", { name: "支線地圖" });
    await expect(map).toBeVisible();
    await expect(map.getByRole("button", { name: /^主線，/ })).toHaveAttribute("aria-current", "location");
    const zoom = page.getByRole("status", { name: /縮放/ });
    // F12 S3: the map opens fitted when the tree is wider or taller than the panel (decision #10).
    const first = Number((await zoom.textContent())?.replace("%", ""));
    expect(first).toBeLessThanOrEqual(100);
    await page.getByRole("button", { name: "放大" }).click();
    await expect(zoom).toHaveText(`${first + 10}%`);
    await map.focus();
    await page.keyboard.press("-");
    await page.keyboard.press("-");
    const lower = Math.max(50, first - 10);
    await expect(zoom).toHaveText(`${lower}%`);
    await page.keyboard.press("0");
    if (lower > 50) await expect(zoom).not.toHaveText(`${lower}%`);
    await expectAccessible(page, MODERATE, '[role="group"][aria-label="支線地圖"]');
    await page.getByRole("button", { name: "全幅" }).click();
    const full = page.getByRole("region", { name: "支線地圖" });
    await expect(full).toBeVisible();
    // The toggle that opened it is replaced by a note, so focus moves into the full map, and comes back to the toggle.
    await expect(full.getByRole("group", { name: "支線地圖" })).toBeFocused();
    await shoot(page, "F2", `map-full-1440-${info.project.name}`);
    await page.keyboard.press("Escape");
    await expect(full).toBeHidden();
    await expect(page.getByRole("button", { name: "全幅" })).toBeFocused();
    await page.keyboard.press("Enter");
    await full.getByRole("button", { name: "收回側欄" }).click();
    await expect(full).toBeHidden();
    await expect(page.getByRole("button", { name: "全幅" })).toBeFocused();
    await map.getByRole("button", { name: new RegExp(`^${tree.other.purpose}，`) }).click();
    await expect(current(page)).toContainText(tree.other.purpose);
    await expect(map.getByRole("button", { name: new RegExp(`^${tree.other.purpose}，`) })).toHaveAttribute("aria-current", "location");
  });

  test("chapters: a milestone adds a divider and the list jumps to it", async ({ page }, info) => {
    const tree = await open(page, info);
    await page.getByRole("radio", { name: "章節" }).click();
    const list = page.getByRole("list", { name: "章節" });
    await expect(list).toBeVisible();
    await page.getByRole("textbox", { name: "里程碑名稱（選填）" }).fill("Milestone e2e");
    await page.getByRole("button", { name: "在這裡加里程碑" }).click();
    await expect(list.getByRole("button", { name: /Milestone e2e/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Milestone e2e" })).toBeVisible();
    await expectAccessible(page, MODERATE, 'ul[aria-label="章節"]');
    // Jump to the first chapter, then to the milestone: the chapter's first message is highlighted in view.
    await list.getByRole("button").first().click();
    await list.getByRole("button", { name: /Milestone e2e/ }).click();
    const divider = page.locator("[data-tg-chapter]").filter({ has: page.getByRole("heading", { name: "Milestone e2e" }) });
    await expect(divider).toBeInViewport();
    expect(tree.root).toBeTruthy();
  });

  test("exports the outline as Markdown, Mermaid and OPML", async ({ page }, info) => {
    const tree = await open(page, info);
    // F8 S9: one 「匯出對話…」 under the outline opens the export dialog; its outline group keeps the three formats.
    await sidePanel(page).getByRole("button", { name: "匯出對話…" }).click();
    const dialog = page.getByRole("dialog", { name: /^匯出「/ });
    const formats = dialog.getByRole("radiogroup", { name: "格式" });
    const contents: Record<string, string> = {};
    for (const [format, name] of [["Markdown", "Markdown 大綱"], ["Mermaid", "Mermaid 心智圖"], ["OPML", "OPML"]] as const) {
      await formats.getByRole("radio", { name }).click();
      const download = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "下載" }).click();
      const file = await download;
      contents[format] = await readFile((await file.path())!, "utf8");
      expect(file.suggestedFilename()).toMatch(new RegExp(`^${tree.rootTitle}\\.(md|mmd|opml)$`));
    }
    expect(contents.Markdown).toContain(`# ${tree.rootTitle}`);
    expect(contents.Markdown).toContain(tree.parent.purpose);
    expect(contents.Mermaid?.split("\n")[0]).toBe("mindmap");
    expect(contents.Mermaid).toContain(tree.other.purpose);
    expect(contents.OPML).toContain('<opml version="2.0">');
    expect(contents.OPML).toContain(`text="${tree.parent.purpose}"`);
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("the outline opens over the conversation, without a map", async ({ page }, info) => {
    const tree = isApi(info) ? await apiTree(page.request) : MOCK_TREE;
    await page.goto(`/?frame=embed&lang=zh-TW&line=${tree.root}`);
    await page.getByRole("button", { name: "大綱" }).click();
    const views = page.getByRole("radiogroup", { name: "檢視方式" });
    await expect(views).toBeVisible();
    await expect(views.getByRole("radio", { name: "地圖" })).toHaveCount(0);
    await row(page, tree.other.purpose).click();
    await expect(current(page)).toContainText(tree.other.purpose);
    await expectAccessible(page);
  });
});
