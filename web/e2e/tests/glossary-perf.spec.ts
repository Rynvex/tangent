import { expect, test, type Page } from "@playwright/test";
import { replies, toast } from "./flows";
import { isApi, messageAction } from "./helpers";

/**
 * F19 §2.3, a measurement rather than a check: scrolling a 440-message
 * conversation with and without glossary terms to mark. It runs only with
 * GLOSSARY_PERF=1 (it prints its numbers; docs/devlog/F19-glossary-ui.md
 * has the ones measured) and asserts only a loose bound, so a loaded
 * machine does not fail the suite.
 */

const TURNS = 220;
const TITLE = "長對話：儲存與資料庫筆記";
const TERMS: ReadonlyArray<readonly [string, string]> = [
  ["ZFS", "寫入時複製的檔案系統。"],
  ["MVCC", "多版本並行控制：讀不擋寫。"],
  ["WAL", "預寫日誌：先寫日誌再寫資料。"],
  ["快照", "某個時間點的唯讀副本。"],
  ["scrub", "把每個區塊讀一遍，找出靜默損壞。"],
];

/** A ChatGPT export with one long conversation; every reply uses the terms, in prose, in a link and in code. */
function longExport(): string {
  const mapping: Record<string, unknown> = { root: { id: "root", parent: null, children: ["n0"], message: null } };
  const total = TURNS * 2;
  for (let index = 0; index < total; index += 1) {
    const user = index % 2 === 0;
    const turn = Math.floor(index / 2) + 1;
    const text = user
      ? `第 ${turn} 個問題：ZFS 的快照和 MVCC 有什麼關係？`
      : [
          `第 ${turn} 段回答。ZFS 用寫入時複製做快照，資料庫的 MVCC 則是讓每個交易看到自己的版本；兩者都靠「不覆寫舊資料」。`,
          "",
          `- WAL 先寫日誌，再寫資料頁，當機後可以重放`,
          `- 定期 scrub 可以找出靜默損壞，MVCC 留下的舊版本則要靠 VACUUM 清掉`,
          `- 參考 [ZFS 文件](https://example.com/zfs) 與 \`zpool scrub tank\``,
          "",
          "```sh",
          "zfs snapshot tank/data@before  # ZFS 快照",
          "```",
          "",
          `結論：第 ${turn} 輪的重點是 WAL 與快照各管一段，${"補充說明。".repeat(20)}`,
        ].join("\n");
    mapping[`n${index}`] = {
      id: `n${index}`,
      parent: index === 0 ? "root" : `n${index - 1}`,
      children: index + 1 < total ? [`n${index + 1}`] : [],
      message: { id: `n${index}`, author: { role: user ? "user" : "assistant" }, recipient: "all", content: { content_type: "text", parts: [text] }, metadata: {} },
    };
  }
  return JSON.stringify([{ title: TITLE, create_time: 1761000000, update_time: 1761000500, conversation_id: "conv-long", mapping }]);
}

interface ScrollRun {
  /** Where the slowest frame was: its index and the scroll offset it was at. */
  slowestAt: { frame: number; top: number };
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
}

/** Scrolls the transcript from top to bottom, one step per frame, and reports the frame times. */
async function scrollRun(page: Page): Promise<ScrollRun> {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-tg-focus-region="chat"] .overflow-auto');
    if (!scroller) throw new Error("no transcript scroller");
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    scroller.scrollTop = 0;
    await frame();
    await frame();
    const times: number[] = [];
    const tops: number[] = [];
    const end = scroller.scrollHeight - scroller.clientHeight;
    let last = performance.now();
    for (let top = 0; top <= end; top += 600) {
      scroller.scrollTop = top;
      await frame();
      const now = performance.now();
      times.push(now - last);
      tops.push(top);
      last = now;
    }
    const slowest = times.indexOf(Math.max(...times));
    const sorted = [...times].sort((a, b) => a - b);
    const sum = times.reduce((total, value) => total + value, 0);
    const round = (value: number) => Math.round(value * 10) / 10;
    return { slowestAt: { frame: slowest, top: tops[slowest] ?? 0 }, frames: times.length, avgMs: round(sum / times.length), p95Ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0), maxMs: round(sorted.at(-1) ?? 0), totalMs: round(sum) };
  });
}

test.describe("a long conversation with a glossary (measurement)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, info) => test.skip(isApi(info) || process.env.GLOSSARY_PERF !== "1", "a measurement: run it with GLOSSARY_PERF=1 on the mock"));
  test.setTimeout(180_000);

  test("scrolling 440 messages before and after five terms are marked", async ({ page }) => {
    await page.goto("/?theme=light&lang=zh-TW");
    await expect(replies(page).first()).toBeVisible();
    await page.getByRole("button", { name: "匯入對話" }).click();
    const dialog = page.getByRole("dialog", { name: "匯入對話" });
    await page.locator('input[type="file"]').setInputFiles({ name: "long.json", mimeType: "application/json", buffer: Buffer.from(longExport(), "utf8") });
    // A file with one conversation comes checked already.
    const box = dialog.getByRole("checkbox", { name: TITLE, exact: true });
    await expect(box).toBeVisible({ timeout: 30_000 });
    if (!(await box.isChecked())) await box.click();
    await dialog.getByRole("button", { name: "快速匯入單篇" }).click();
    await dialog.getByRole("button", { name: "純匯入" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.locator("li[data-message-id]")).toHaveCount(TURNS * 2, { timeout: 60_000 });

    // Long tasks (over 50 ms on the main thread), for the whole run.
    await page.evaluate(() => {
      const store = window as unknown as { __longTasks: Array<{ at: number; ms: number }> };
      store.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.__longTasks.push({ at: Math.round(entry.startTime), ms: Math.round(entry.duration) });
      }).observe({ entryTypes: ["longtask"] });
    });
    const mark = () => page.evaluate(() => Math.round(performance.now()));
    const longTasks = (from: number, to: number) => page.evaluate(([start, end]) => (window as unknown as { __longTasks: Array<{ at: number; ms: number }> }).__longTasks.filter((task) => task.at >= start! && task.at < end!).map((task) => task.ms), [from, to]);

    // Without terms: two passes (the first renders every row once; the second is the steady state).
    const t0 = await mark();
    const before = [await scrollRun(page), await scrollRun(page)];
    expect(await page.locator("[data-tg-term-mark]").count()).toBe(0);
    const t1 = await mark();

    // Five terms, saved from a reply's menu. GLOSSARY_PERF_CONTROL=1 opens the same menu and dialog five times and
    // cancels: the same steps without a glossary, as a control.
    const control = process.env.GLOSSARY_PERF_CONTROL === "1";
    for (const [term, explanation] of TERMS) {
      const reply = replies(page).last();
      await reply.scrollIntoViewIfNeeded();
      await messageAction(reply, "存進名詞表");
      const save = page.getByRole("dialog", { name: "存進名詞表" });
      await save.getByRole("textbox", { name: "名詞" }).fill(term);
      await save.getByRole("textbox", { name: "解釋" }).fill(explanation);
      if (control) {
        await save.getByRole("button", { name: "取消" }).click();
        await expect(save).toBeHidden();
        continue;
      }
      await save.getByRole("button", { name: "存進名詞表" }).click();
      await expect(save).toBeHidden();
      await expect(toast(page)).toContainText("已存進名詞表。");
    }
    // Whatever the last change still has to render in the background is given time to finish.
    await page.waitForTimeout(1500);

    const t2 = await mark();
    const after = [await scrollRun(page), await scrollRun(page), await scrollRun(page)];
    const t3 = await mark();
    const tasks = { scrollingBefore: await longTasks(t0, t1), savingTerms: await longTasks(t1, t2), scrollingAfter: await longTasks(t2, t3) };
    const marks = await page.locator("[data-tg-term-mark]").count();
    const inCode = await page.locator("pre [data-tg-term-mark], code [data-tg-term-mark], a [data-tg-term-mark]").count();
    console.info(`GLOSSARY_PERF ${JSON.stringify({ messages: TURNS * 2, terms: TERMS.length, marks, inCode, before, after, longTasksMs: tasks })}`);

    if (control) return;
    // Every reply marks each of the five terms once, never in code or links.
    expect(marks).toBe(TURNS * TERMS.length);
    expect(inCode).toBe(0);
    // Loose: a pass with marks must not be several times slower than one without.
    expect(after[1]!.avgMs).toBeLessThan(Math.max(before[1]!.avgMs * 3, 50));
  });
});
