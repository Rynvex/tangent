// Side-by-side check with the design prototype (F0–F3 devlogs).
// Usage: node scripts/compare-shots.mjs <prototype base URL> <step>
//   Serve docs/design/prototype-v2 first, e.g.
//   python3 -m http.server 8799 --bind 127.0.0.1 --directory docs/design/prototype-v2
// Takes prototype-<name>.png at the same size as each demo-<name>.png already
// in docs/devlog/screenshots/<step>/ and writes compare-<name>.png (prototype left, demo right).
import { chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [base, step = "F1"] = process.argv.slice(2);
if (!base) throw new Error("usage: compare-shots.mjs <prototype base URL> [step]");
const dir = fileURLToPath(new URL(`../../../docs/devlog/screenshots/${step}/`, import.meta.url));
const PROTOTYPE = encodeURI("Tangent 原型.dc.html");

/** Clicks in the prototype that reach the F2 screens (the fork pill of AI #17, then branch nas-b3). */
const ENTER_B3 = [{ click: "button[aria-expanded]", hasText: "條支線" }, { text: "4TB 與 8TB 硬碟的每 TB 成本與保固" }];

/** name → prototype query, viewport and the keys or clicks after load, per step. */
const PAIRS_BY_STEP = {
  F3: [
    { name: "1440-a9-notes", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [{ role: "tab", name: "紀要" }] },
    { name: "1440-a13-settings", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [{ role: "button", name: "設定" }] },
    { name: "1440-a4-unread", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: ENTER_B3 },
    { name: "1440-embed", query: "frame=embed&theme=host", width: 1440, height: 900 },
    { name: "375-a9-notes", query: "frame=mobile&theme=light", width: 375, height: 812, steps: [{ role: "button", name: "大綱" }, { role: "tab", name: "紀要" }] },
  ],
  F2: [
    { name: "1440-a3-open", query: "frame=desktop&theme=light", width: 1440, height: 900, keys: ["Control+b"] },
    { name: "1440-a4-branch", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: ENTER_B3 },
    { name: "1440-a4-peek", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [...ENTER_B3, { role: "button", name: "預覽分岔點" }] },
    { name: "1440-a5-review", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [...ENTER_B3, { role: "button", name: "結束並帶回", wait: 4500 }] },
    { name: "1440-a6-promote", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [...ENTER_B3, { role: "button", name: "升為主線" }] },
    { name: "1440-a8-outline", query: "frame=desktop&theme=light", width: 1440, height: 900 },
    { name: "1440-a8-map", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [{ role: "radio", name: "地圖" }] },
    { name: "1440-a10-chapters", query: "frame=desktop&theme=light", width: 1440, height: 900, steps: [{ role: "radio", name: "章節" }] },
    { name: "1440-a11-preview", query: "frame=desktop&theme=light", width: 1440, height: 900, keys: ["Control+Shift+P"] },
    { name: "420-a4-branch", query: "frame=embed&theme=host", width: 420, height: 900, steps: ENTER_B3 },
    { name: "375-a4-branch", query: "frame=mobile&theme=light", width: 375, height: 812, steps: ENTER_B3 },
  ],
};

/** Runs one scripted step in the prototype page. */
async function run(page, step) {
  if (step.click) await page.locator(step.click).filter({ hasText: step.hasText }).first().click();
  else if (step.role) await page.getByRole(step.role, { name: step.name }).first().click();
  else await page.locator("main").getByText(step.text).filter({ visible: true }).first().click();
  await page.waitForTimeout(step.wait ?? 600);
}

const PAIRS = PAIRS_BY_STEP[step] ?? [
  { name: "1440-light", query: "frame=desktop&theme=light", width: 1440, height: 900 },
  { name: "1440-dark-aiError", query: "frame=desktop&theme=dark&state=aiError", width: 1440, height: 900 },
  { name: "1440-preview", query: "frame=desktop&theme=light", width: 1440, height: 900, keys: ["Control+Shift+P"] },
  { name: "420-embed-host", query: "frame=embed&theme=host", width: 420, height: 900 },
  { name: "375-light", query: "frame=mobile&theme=light", width: 375, height: 812 },
];

const browser = await chromium.launch();
for (const pair of PAIRS) {
  const demo = `${dir}demo-${pair.name}.png`;
  if (!existsSync(demo)) {
    console.log(`skip ${pair.name}: no ${demo}`);
    continue;
  }
  const page = await browser.newPage({ viewport: { width: pair.width, height: pair.height }, locale: "zh-TW", timezoneId: "Asia/Taipei" });
  await page.goto(`${base}/${PROTOTYPE}?${pair.query}`);
  await page.waitForTimeout(2500);
  for (const key of pair.keys ?? []) {
    await page.keyboard.press(key);
    await page.waitForTimeout(600);
  }
  for (const action of pair.steps ?? []) await run(page, action);
  await page.screenshot({ path: `${dir}prototype-${pair.name}.png` });
  await page.close();

  const image = (file) => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  const sheet = await browser.newPage({ viewport: { width: pair.width * 2 + 24, height: pair.height + 40 } });
  await sheet.setContent(`<body style="margin:0;background:#888;font:14px sans-serif;color:#fff">
    <div style="display:flex;gap:24px;padding:0">
      <figure style="margin:0"><figcaption style="height:40px;line-height:40px;padding-left:8px">prototype</figcaption><img src="${image(`${dir}prototype-${pair.name}.png`)}"></figure>
      <figure style="margin:0"><figcaption style="height:40px;line-height:40px;padding-left:8px">demo</figcaption><img src="${image(demo)}"></figure>
    </div></body>`);
  await sheet.screenshot({ path: `${dir}compare-${pair.name}.png`, fullPage: true });
  await sheet.close();
  console.log(`compare-${pair.name}.png`);
}
await browser.close();
