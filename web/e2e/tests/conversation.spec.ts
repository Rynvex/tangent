import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { API, expectAccessible, isApi, MODERATE, shoot } from "./helpers";

/**
 * F1 main flow, against the mock (project `mock`) and the reference server
 * with the fake runner (project `api`): new conversation → send → see it
 * stream → done → preview → cancel a turn → automatic retry (`[fake:retry]`)
 * and a failed reply with retry (`[fake:error]`) → a read-only identity has
 * no composer. Run at 1440, 420 (embedded) and 375 (phone).
 */

const QUESTION = "When should I visit Kyoto, and how many days do I need for the temples, the food markets and a day trip to Nara?";

const composer = (page: Page) => page.getByRole("textbox", { name: "訊息" });
const replies = (page: Page) => page.locator("article[data-tg-message]");

/** A conversation to work in: a new one through the UI, or (embedded, no list) one made through the API. */
async function startConversation(page: Page, info: TestInfo, via: "list" | "drawer" | "embed"): Promise<void> {
  if (via === "embed") {
    if (!isApi(info)) {
      await page.goto("/?frame=embed&lang=zh-TW");
    } else {
      const response = await page.request.post(`${API.url()}/lines`, { headers: { Authorization: `Bearer ${API.token()}` }, data: { title: "Embedded e2e" } });
      expect(response.status()).toBe(201);
      const line = (await response.json()) as { id: string };
      await page.goto(`/?frame=embed&lang=zh-TW&line=${line.id}`);
    }
    await expect(composer(page)).toBeVisible();
    // Count replies only once the messages are there.
    await expect(page.getByRole("list", { name: "訊息" }).or(page.getByText("還沒有訊息。在下方輸入第一則。")).first()).toBeVisible();
    return;
  }
  await page.goto("/?theme=light&lang=zh-TW");
  if (via === "drawer") await page.getByRole("button", { name: "展開對話清單" }).click();
  const list = page.getByRole("navigation", { name: "對話", exact: true });
  await list.getByRole("button", { name: "新對話" }).first().click();
  await expect(page.getByText("還沒有訊息。在下方輸入第一則。")).toBeVisible();
}

/**
 * Records, in the page, whether reply number `index` was ever busy with some
 * text in it (a MutationObserver sees every step, however short the stream).
 */
async function watchStreaming(page: Page, index: number): Promise<void> {
  await page.evaluate((n) => {
    const state = window as unknown as { __tgSawStreaming?: boolean; __tgLostText?: boolean };
    state.__tgSawStreaming = false;
    state.__tgLostText = false;
    const check = () => {
      const reply = document.querySelectorAll("article[data-tg-message]")[n];
      if (reply?.getAttribute("aria-busy") !== "true") return;
      const text = reply.querySelector("[data-tg-markdown], [data-tg-markdown-pending]")?.textContent ?? "";
      if (text.length > 6) state.__tgSawStreaming = true;
      // Once text streamed, a still-pending reply must never go back to empty (review: end-of-stream flash).
      else if (state.__tgSawStreaming) state.__tgLostText = true;
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, index);
}

/**
 * The real server's fake runner waits a moment before answering, so the stop
 * button is on screen before the reply ends even on a loaded machine (it
 * streamed out first now and then: R9 follow-up). The mock streams slowly anyway.
 */
const STREAM_WAIT = "[fake:wait=1s]";

async function sendAndWatchStream(page: Page, info: TestInfo): Promise<void> {
  const before = await replies(page).count();
  const question = isApi(info) ? `${QUESTION} ${STREAM_WAIT}` : QUESTION;
  await watchStreaming(page, before);
  await composer(page).fill(question);
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("");
  // Exact: a fast fake reply ("Fake reply to: …") contains the question too.
  await expect(page.getByText(question, { exact: true })).toBeVisible();
  // Streaming: the reply is busy, the stop button replaces send, and text arrives before it is done.
  const reply = replies(page).nth(before);
  await expect(page.getByRole("button", { name: "停止回覆" })).toBeVisible();
  await expect(reply).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });
  const seen = await page.evaluate(() => {
    const state = window as unknown as { __tgSawStreaming?: boolean; __tgLostText?: boolean };
    return { streamed: state.__tgSawStreaming, lost: state.__tgLostText };
  });
  expect(seen).toEqual({ streamed: true, lost: false });
  await expect(page.getByRole("button", { name: "送出", exact: true })).toBeVisible();
  expect(((await reply.textContent()) ?? "").length).toBeGreaterThan(20);
}

async function preview(page: Page, info: TestInfo): Promise<void> {
  await composer(page).fill("And what about the food?");
  await page.getByRole("button", { name: /送出前預覽/ }).click();
  // Desktop: a non-modal panel in the conversation column (F2, DESIGN §12); narrower frames: the drawer.
  const drawer = page.getByRole("dialog", { name: "送出前預覽" }).or(page.getByRole("region", { name: "送出前預覽" }));
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: /規則/ })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /你的訊息/ })).toBeVisible();
  await expect(drawer.getByText(isApi(info) ? /伺服器沒有這個模型的價格|預估輸入費用/ : /預估輸入費用/)).toBeVisible();
  await drawer.getByRole("button", { name: /你的訊息/ }).click();
  await expect(drawer.getByText("And what about the food?")).toBeVisible();
  await expectAccessible(page, MODERATE, '[role="dialog"], section[aria-label="送出前預覽"]');
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await composer(page).fill("");
}

async function cancelTurn(page: Page): Promise<void> {
  const before = await replies(page).count();
  await composer(page).fill("[fake:slow] take your time");
  await composer(page).press("Enter");
  await page.getByRole("button", { name: "停止回覆" }).click();
  await expect(replies(page).nth(before)).toContainText("已停止");
  await expect(page.getByRole("button", { name: "送出", exact: true })).toBeVisible();
}

async function retries(page: Page): Promise<void> {
  const before = await replies(page).count();
  await composer(page).fill("[fake:retry] [fake:slow] retry me");
  await composer(page).press("Enter");
  const banner = page.locator('[data-tg-banner="aiError"]');
  await expect(banner).toContainText("第 1 / 2 次");
  await expect(banner).toBeHidden({ timeout: 15_000 });
  await expect(replies(page).nth(before)).not.toHaveAttribute("aria-busy", "true", { timeout: 15_000 });

  await composer(page).fill("[fake:error] fail please");
  await composer(page).press("Enter");
  const failed = replies(page).nth(before + 1);
  await expect(failed.getByRole("alert")).toContainText("回覆失敗");
  // Retry runs the same turn again (POST /retry): no new user message, a new reply; the failed one stays.
  const users = await page.locator("[data-tg-message]:not(article)").count();
  await failed.getByRole("button", { name: "重試" }).click();
  await expect(replies(page)).toHaveCount(before + 3);
  await expect(replies(page).nth(before + 2).getByRole("alert")).toContainText("回覆失敗");
  await expect(page.locator("[data-tg-message]:not(article)")).toHaveCount(users);
  await expect(failed.getByRole("alert")).toContainText("回覆失敗");
}

/** True when the server knows a read-only token (B4.1 `TANGENT_VIEWER_TOKEN`). */
async function viewerSupported(page: Page): Promise<boolean> {
  const response = await page.request.get(`${API.url()}/lines`, { headers: { Authorization: `Bearer ${API.viewerToken()}` } });
  return response.status() === 200;
}

async function readOnly(page: Page, info: TestInfo, query: string): Promise<void> {
  if (isApi(info)) {
    test.skip(!(await viewerSupported(page)), "the reference server does not accept a read-only token yet (B4.1 TANGENT_VIEWER_TOKEN)");
    const write = await page.request.post(`${API.url()}/lines`, { headers: { Authorization: `Bearer ${API.viewerToken()}` }, data: {} });
    expect(write.status()).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe("forbidden");
  }
  await page.goto(`/${query}${query ? "&" : "?"}as=viewer`);
  await expect(page.locator('[data-tg-banner="readonly"]')).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "檢視權限・不能送出" })).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "從這則開支線" })).toHaveCount(0);
}

test.describe("1440 desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("new conversation, stream, preview, cancel, retries", async ({ page }, info) => {
    await startConversation(page, info, "list");
    await sendAndWatchStream(page, info);
    await shoot(page, "F1", `demo-1440-${info.project.name}`);
    await expectAccessible(page);
    await preview(page, info);
    await cancelTurn(page);
    await retries(page);
  });

  test("a read-only identity has no composer", async ({ page }, info) => {
    await readOnly(page, info, "?theme=light&lang=zh-TW");
  });

  test("the docked preview never sends one line's draft to another line", async ({ page }, info) => {
    // The mock answers previews in the page; only the reference server's requests can be watched.
    test.skip(!isApi(info), "preview requests are only observable against the reference server");
    const create = async (title: string) => {
      const response = await page.request.post(`${API.url()}/lines`, { headers: { Authorization: `Bearer ${API.token()}` }, data: { title } });
      expect(response.status()).toBe(201);
      return ((await response.json()) as { id: string }).id;
    };
    const stamp = `${Date.now()}-${info.repeatEachIndex}`;
    const first = await create(`Draft A ${stamp}`);
    const second = await create(`Draft B ${stamp}`);
    const sent: Array<{ lineId: string; content: string }> = [];
    page.on("request", (request) => {
      const match = /\/lines\/([^/]+)\/preview$/.exec(new URL(request.url()).pathname);
      if (!match?.[1] || request.method() !== "POST") return;
      const body = (request.postDataJSON() ?? {}) as { content?: string };
      sent.push({ lineId: match[1], content: body.content ?? "" });
    });
    await page.goto(`/?theme=light&lang=zh-TW&line=${first}`);
    await composer(page).fill("only for line A");
    await page.getByRole("button", { name: /送出前預覽/ }).click();
    await expect(page.getByRole("region", { name: "送出前預覽" })).toBeVisible();
    await expect.poll(() => sent.some((call) => call.lineId === first && call.content === "only for line A")).toBe(true);
    // Switch lines with the panel open, then let any debounce run out.
    await page.getByRole("navigation", { name: "對話", exact: true }).getByRole("button", { name: new RegExp(`^Draft B ${stamp}`) }).click();
    await expect(composer(page)).toHaveValue("");
    await expect.poll(() => sent.some((call) => call.lineId === second)).toBe(true);
    await page.waitForTimeout(800);
    expect(sent.filter((call) => call.lineId === second && call.content.includes("only for line A"))).toEqual([]);
    expect(sent.filter((call) => call.lineId === second).every((call) => call.content === "")).toBe(true);
  });
});

test.describe("420 embedded in a host", () => {
  test.use({ viewport: { width: 420, height: 900 } });

  test("embedded conversation streams and previews in the host theme", async ({ page }, info) => {
    await startConversation(page, info, "embed");
    await expect(page.locator("[data-tg-root]")).toHaveAttribute("data-tg-theme", "host");
    await sendAndWatchStream(page, info);
    await shoot(page, "F1", `demo-420-embed-${info.project.name}`);
    await expectAccessible(page);
    await preview(page, info);
    await cancelTurn(page);
    await retries(page);
  });

  test("a read-only identity has no composer", async ({ page }, info) => {
    await readOnly(page, info, "?frame=embed&lang=zh-TW");
  });
});

test.describe("375 phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("new conversation from the drawer, stream, preview, cancel, retries", async ({ page }, info) => {
    await startConversation(page, info, "drawer");
    await sendAndWatchStream(page, info);
    await shoot(page, "F1", `demo-375-${info.project.name}`);
    await expectAccessible(page);
    const send = await page.getByRole("button", { name: "送出", exact: true }).boundingBox();
    expect(send?.height).toBeGreaterThanOrEqual(44);
    await preview(page, info);
    await cancelTurn(page);
    await retries(page);
  });

  test("a read-only identity has no composer", async ({ page }, info) => {
    await readOnly(page, info, "?theme=light&lang=zh-TW");
  });
});
