import { expect, type Page, type TestInfo } from "@playwright/test";
import { API, isApi } from "./helpers";

/** Shared steps of the F3 specs (notes, settings, features, embed), in zh-TW. */

export const composer = (page: Page) => page.getByRole("textbox", { name: "訊息" });
export const replies = (page: Page) => page.locator("article[data-tg-message]");
/** The demo frame's toast (not the message list's own live region). */
export const toast = (page: Page) => page.locator('div.pointer-events-none[role="status"][aria-live="polite"]');
export const sidePanel = (page: Page) => page.getByRole("complementary", { name: "側欄" }).or(page.getByRole("dialog", { name: "側欄" }));

/** Sends a message and waits until its reply is done. */
export async function turn(page: Page, text: string): Promise<void> {
  const before = await replies(page).count();
  await composer(page).fill(text);
  await composer(page).press("Enter");
  await expect(replies(page)).toHaveCount(before + 1);
  await expect(replies(page).nth(before)).not.toHaveAttribute("aria-busy", "true", { timeout: 20_000 });
}

const auth = () => ({ Authorization: `Bearer ${API.token()}` });

/** The goal every fresh API conversation starts with (see freshConversation). */
export const E2E_GOAL = "Plan the Kyoto trip (e2e)";

/** The server behind this project's demo: `api-core` has its own (TANGENT_FEATURES=none). */
function serverUrl(info?: TestInfo): string {
  return info?.project.name === "api-core" ? `http://127.0.0.1:${process.env.TANGENT_E2E_CORE_API_PORT}/api` : API.url();
}

/** A request to the reference server of this project (`api` unless `info` says `api-core`). */
export async function apiCall<T>(page: Page, method: "get" | "post" | "put" | "delete", path: string, data?: unknown, info?: TestInfo): Promise<T> {
  const response = await page.request[method](`${serverUrl(info)}${path}`, { headers: auth(), ...(data === undefined ? {} : { data }) });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

/** One finished turn through the API. */
export async function apiTurn(page: Page, lineId: string, content: string, info?: TestInfo): Promise<void> {
  await apiCall(page, "post", `/lines/${lineId}/messages`, { content }, info);
  await expect.poll(async () => (await apiCall<{ status: string }>(page, "get", `/lines/${lineId}`, undefined, info)).status, { timeout: 15_000 }).toBe("idle");
}

/**
 * A fresh conversation with `turns` finished turns, opened at `query`: made
 * through the API on the server, or in the UI ("新對話") on the mock.
 */
export async function freshConversation(page: Page, info: TestInfo, query: string, turns = 1, title = "F3 e2e"): Promise<string | null> {
  if (isApi(info)) {
    const line = await apiCall<{ id: string }>(page, "post", "/lines", { title }, info);
    // B9 goal:suggest proposes a goal after the main line's 2nd reply when there is none; a goal keeps the
    // earlier specs' inbox counts as they were (the mock's "okr" has one in its scenario for the same reason).
    if (info.project.name === "api") await apiCall(page, "put", `/lines/${line.id}/goal`, { text: E2E_GOAL }, info);
    for (let i = 1; i <= turns; i += 1) await apiTurn(page, line.id, `Question ${i} about the Kyoto trip`, info);
    await page.goto(`/?${query}&line=${line.id}`);
    await expect(replies(page)).toHaveCount(turns);
    return line.id;
  }
  await page.goto(`/?${query}&line=okr`);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole("list", { name: "訊息" }).or(page.getByText("還沒有訊息。在下方輸入第一則。")).first()).toBeVisible();
  const before = await replies(page).count();
  for (let i = 1; i <= turns; i += 1) await turn(page, `Question ${i} about the Kyoto trip`);
  await expect(replies(page)).toHaveCount(before + turns);
  return null;
}
