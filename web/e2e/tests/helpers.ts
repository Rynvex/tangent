import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** Screenshots go next to a devlog only with UPDATE_SCREENSHOTS=1; a normal run never touches docs/. */
const UPDATE_SCREENSHOTS = process.env.UPDATE_SCREENSHOTS === "1";

export async function shoot(page: Page, step: string, name: string): Promise<void> {
  if (!UPDATE_SCREENSHOTS) return;
  const dir = fileURLToPath(new URL(`../../../docs/devlog/screenshots/${step}/`, import.meta.url));
  await page.screenshot({ path: `${dir}${name}.png` });
}

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
export const SERIOUS = ["serious", "critical"];
export const MODERATE = ["moderate", ...SERIOUS];

/** No axe violations at or above `impacts` (WCAG 2.2 AA rule set); the demo frame fails on serious+, package components on moderate+. */
export async function expectAccessible(page: Page, impacts: readonly string[] = SERIOUS, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  const results = await (include ? builder.include(include) : builder).analyze();
  const blocking = results.violations.filter((violation) => impacts.includes(violation.impact ?? ""));
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** The `api` and `api-core` projects (a reference server behind the demo). */
export const isApi = (info: TestInfo) => info.project.name.startsWith("api");

/** The reference server of the api project (127.0.0.1 and the tokens the config chose). */
export const API = {
  url: () => `http://127.0.0.1:${process.env.TANGENT_E2E_API_PORT}/api`,
  token: () => process.env.TANGENT_E2E_TOKEN ?? "",
  viewerToken: () => process.env.TANGENT_E2E_VIEWER_TOKEN ?? "",
};

/** Points at the message itself (a row is wider than a user's bubble), so its hover toolbar shows and takes the pointer. */
export async function hoverMessage(message: Locator): Promise<void> {
  const own = message.locator("[data-tg-message]");
  const target = (await own.count()) > 0 ? own.first() : message;
  await target.hover().catch(() => undefined);
  // The toolbar builds its buttons the first time its message is pointed at (F8 S1).
  await message.locator("[data-tg-actions] > button").first().waitFor({ state: "attached", timeout: 3000 }).catch(() => undefined);
}

/**
 * A message's action wherever F8 S1 put it: in view on the hover toolbar, in
 * the toolbar's 「更多動作」 menu, or — on a touch screen, where the toolbar
 * gives way — in the label row's action sheet. String names match exactly
 * (釘選 is not 取消釘選).
 */
export async function messageAction(message: Locator, name: string | RegExp, { tap = false }: { tap?: boolean } = {}): Promise<void> {
  const page = message.page();
  const exact = typeof name === "string";
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  await hoverMessage(message);
  const shown = message.locator("[data-tg-actions]").getByRole("button", { name, exact });
  if ((await shown.count()) > 0 && (await shown.first().isVisible())) return press(shown.first());
  await press(message.getByRole("button", { name: "更多動作" }).first());
  await press(page.getByRole("menuitem", { name, exact }).or(page.getByRole("dialog").getByRole("button", { name, exact })).first());
}

/** A message's argument type badge (F8 S1: only once it has a type). */
export const argBadge = (message: Locator) => message.locator("[data-tg-arg-badge]");

/** Sets a message's argument type from its 「更多動作」 (標論證類型… → the kind), or from the touch sheet. */
export async function setArgType(message: Locator, kind: string, { tap = false }: { tap?: boolean } = {}): Promise<void> {
  const page = message.page();
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  await hoverMessage(message);
  await press(message.getByRole("button", { name: "更多動作" }).first());
  const entry = page.getByRole("menuitem", { name: "標論證類型…" }).or(page.getByRole("dialog").getByRole("button", { name: /^(標論證類型…|改類型…)$/ })).first();
  await entry.waitFor();
  const inMenu = (await entry.getAttribute("role")) === "menuitem";
  await press(entry);
  await press(inMenu ? page.getByRole("menuitem", { name: kind, exact: true }) : page.getByRole("dialog").getByRole("button", { name: kind, exact: true }));
}
