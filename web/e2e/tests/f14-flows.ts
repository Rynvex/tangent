import { expect, type Locator, type Page } from "@playwright/test";
import { copyFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Shared steps of the F14 / F15 specs on the mock: the three exports and their five conversations. */

export const Q = "theme=light&lang=zh-TW";
const FIXTURES = fileURLToPath(new URL("../fixtures/f14/", import.meta.url));

/** The three files; the Markdown one has no dates, so its modified time (08/18) places it (decision #4). */
export function files(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "tangent-f14-"));
  const notes = join(dir, "壓測筆記.md");
  copyFileSync(join(FIXTURES, "壓測筆記.md"), notes);
  const fileTime = new Date("2026-08-18T09:00:00+08:00");
  utimesSync(notes, fileTime, fileTime);
  return [join(FIXTURES, "chatgpt-pg.json"), join(FIXTURES, "claude-pg.json"), notes];
}

export const nodeOf = (dialog: Locator, title: string) => dialog.locator("[data-tg-blueprint-node]").filter({ hasText: title });

/** S1: load the files, search "pg", select every match but the two older ones. */
export async function pickFive(page: Page, dialog: Locator, tap = false) {
  await page.locator('input[type="file"]').setInputFiles(files());
  await expect(dialog.getByText("Markdown・1 篇", { exact: true })).toBeVisible();
  await dialog.getByRole("searchbox", { name: "搜尋標題與首問" }).fill("pg");
  await expect(dialog.getByText(tap ? "7 / 9" : "符合 7 / 9 篇")).toBeVisible();
  const press = (target: Locator) => (tap ? target.tap() : target.click());
  await press(dialog.getByRole("button", { name: tap ? "全選" : "全選符合的" }));
  await press(dialog.getByRole("checkbox", { name: "PG 備份與 PITR" }));
  await press(dialog.getByRole("checkbox", { name: "pgvector 要不要用" }));
  await expect(dialog.getByText("已勾選 5 篇・共 54 則訊息・橫跨 2026/08/12～08/20")).toBeVisible();
}
