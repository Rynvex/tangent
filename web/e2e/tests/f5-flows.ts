import { messageAction } from "./helpers";
import { expect, type Page } from "@playwright/test";
import { replies, sidePanel, turn } from "./flows";

/** Shared steps of the F5 specs (phases 1–3). */

export const branchBar = (page: Page) => page.getByRole("region", { name: "支線資訊" });
export const outlineTree = (page: Page) => sidePanel(page).getByRole("tree", { name: "支線大綱" });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const outlineRow = (page: Page, purpose: string) => outlineTree(page).getByRole("treeitem", { name: new RegExp(`^${escape(purpose)}`) });

export async function openTab(page: Page, name: "結構" | "紀要" | "待處理"): Promise<void> {
  await sidePanel(page).getByRole("tab", { name: new RegExp(`^${name}`) }).click();
}

export async function openBranch(page: Page, purpose: string): Promise<void> {
  const from = replies(page).last();
  await from.hover();
  await messageAction(from, "從這則開支線");
  const dialog = page.getByRole("dialog", { name: "開支線" });
  await dialog.getByRole("textbox", { name: /目的/ }).fill(purpose);
  await dialog.getByRole("radio", { name: /查證/ }).click();
  await dialog.getByRole("button", { name: "開支線" }).click();
  await expect(dialog).toBeHidden();
  await expect(branchBar(page)).toContainText(purpose);
}

export async function backToMain(page: Page): Promise<void> {
  await branchBar(page).getByRole("button", { name: "回主線" }).click();
  await expect(branchBar(page)).toHaveCount(0);
}

/** A branch with one turn, ended 不帶回 with a reason (its ending), then back on the main line. */
export async function endedBranch(page: Page, purpose: string, reason: string): Promise<void> {
  await openBranch(page, purpose);
  await turn(page, `${purpose}?`);
  await branchBar(page).getByRole("button", { name: "不帶回" }).click();
  const discard = page.getByRole("dialog", { name: "結束支線，不帶回" });
  await discard.getByRole("textbox", { name: "原因（選填）" }).fill(reason);
  await discard.getByRole("button", { name: "結束，不帶回" }).click();
  await expect(discard).toBeHidden();
  await backToMain(page);
}
