import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

type Side = "light" | "dark";

/** The body of the first rule whose selector list is exactly `selector` (starting a line). */
function block(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed block for ${selector}`);
}

/** Token names declared in a block, in order (duplicates kept). */
function declared(body: string): string[] {
  return [...body.matchAll(/^\s*(--tg-[\w-]+):/gm)].map((match) => match[1]!);
}

const BASE = block("[data-tg-root],\n[data-tg-root] [data-tg-theme]");
const HOST = block('[data-tg-root][data-tg-theme="host"],\n[data-tg-root] [data-tg-theme="host"]');

interface StyleRule {
  selectors: string[];
  body: string;
}

/** Every style rule (selector list + body), descending into @media / @layer and skipping @keyframes, @font-face and @theme. */
function styleRules(): StyleRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: StyleRule[] = [];
  const walk = (from: number, to: number) => {
    let start = from;
    for (let i = from; i < to; i += 1) {
      const char = text[i];
      if (char === ";" || char === "}") start = i + 1;
      if (char !== "{") continue;
      const prelude = text.slice(start, i).trim();
      let depth = 0;
      let end = i;
      for (; end < to; end += 1) {
        if (text[end] === "{") depth += 1;
        if (text[end] === "}") depth -= 1;
        if (depth === 0) break;
      }
      if (/^@(media|layer|supports)/.test(prelude)) walk(i + 1, end);
      else if (!prelude.startsWith("@")) rules.push({ selectors: prelude.split(",").map((part) => part.trim()), body: text.slice(i + 1, end) });
      i = end;
      start = end + 1;
    }
  };
  walk(0, text.length);
  return rules;
}

/** Every `--tg-name: light-dark(#light, #dark)` hex pair of the base block. */
function themed(): Map<string, Record<Side, string>> {
  const found = new Map<string, Record<Side, string>>();
  for (const match of BASE.matchAll(/(--tg-[\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)) {
    found.set(match[1]!, { light: match[2]!, dark: match[3]! });
  }
  return found;
}

/** Every `--tg-name: #hex` of the host block. */
function hostColors(): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of HOST.matchAll(/(--tg-[\w-]+):\s*(#[0-9a-f]{6})\b/gi)) found.set(match[1]!, match[2]!);
  return found;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ["--tg-background", "--tg-surface", "--tg-surface-sunken"];
/** Inputs also sit on raised surfaces (dialogs, popovers). */
const INPUT_BACKGROUNDS = [...BACKGROUNDS, "--tg-surface-raised"];
const TEXT = ["--tg-foreground", "--tg-muted", "--tg-subtle"];
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe("design tokens v3", () => {
  const all = themed();
  const host = hostColors();

  it.each(["light", "dark"] as const)("text tokens reach 4.5:1 and the focus ring 3:1 in %s", (side) => {
    for (const background of BACKGROUNDS) {
      const bg = all.get(background)![side];
      for (const text of TEXT) expect(contrast(all.get(text)![side], bg), `${text} on ${background}`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(all.get("--tg-ring")![side], bg), `ring on ${background}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it.each(["light", "dark"] as const)("the input border reaches 3:1 on every surface in %s (review §2 #1)", (side) => {
    for (const background of INPUT_BACKGROUNDS) {
      const ratio = contrast(all.get("--tg-border-input")![side], all.get(background)![side]);
      expect(ratio, `border-input on ${background}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it.each(["light", "dark"] as const)("the ring marks a highlighted row at 3:1 on accent and raised in %s (F0 review M10)", (side) => {
    for (const fill of ["--tg-accent", "--tg-surface-raised"]) {
      expect(contrast(all.get("--tg-ring")![side], all.get(fill)![side]), `ring on ${fill}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("the host theme keeps text at 4.5:1 and the ring and input border at 3:1", () => {
    for (const background of INPUT_BACKGROUNDS) {
      const bg = host.get(background)!;
      for (const text of [...TEXT, "--tg-primary-text"]) expect(contrast(host.get(text)!, bg), `${text} on ${background}`).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(host.get("--tg-ring")!, bg), `ring on ${background}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
      expect(contrast(host.get("--tg-border-input")!, bg), `border-input on ${background}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it.each(["light", "dark"] as const)("muted text reaches 4.5:1 on the accent and soft fills in %s (subtle does not)", (side) => {
    for (const fill of ["--tg-accent", "--tg-primary-soft", "--tg-warning-soft", "--tg-destructive-soft"]) {
      expect(contrast(all.get("--tg-muted")![side], all.get(fill)![side]), `muted on ${fill}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("declares each token once per block, and the host block only overrides known tokens", () => {
    const base = declared(BASE);
    expect(new Set(base).size).toBe(base.length);
    const overrides = declared(HOST);
    expect(new Set(overrides).size).toBe(overrides.length);
    expect(overrides.filter((name) => !base.includes(name))).toEqual([]);
    expect(all.size).toBeGreaterThan(40);
  });

  it("keeps every v2 token name and value (handoff tokens.css is a superset)", () => {
    expect(all.get("--tg-background")).toEqual({ light: "#f7f5f0", dark: "#111214" });
    expect(all.get("--tg-primary")).toEqual({ light: "#0f766e", dark: "#2dd4bf" });
    expect(all.get("--tg-subtle")).toEqual({ light: "#706a5e", dark: "#8a867d" });
    for (const name of ["--tg-primary-text", "--tg-highlight", "--tg-suggestion", "--tg-leaf-deadend", "--tg-arg-con"]) {
      expect(all.has(name), name).toBe(true);
    }
  });

  it("exposes every colour token to Tailwind", () => {
    const theme = block("@theme inline");
    for (const name of all.keys()) expect(theme, name).toContain(`--color-${name.slice(2)}: var(${name});`);
  });

  it("scopes every rule under [data-tg-root], so nothing reaches the host page (F0 review H1)", () => {
    const rules = styleRules();
    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) {
      for (const selector of rule.selectors) expect(selector, selector).toMatch(/^\[data-tg-root\]/);
    }
    expect(css).not.toMatch(/:root|\[data-theme|\[data-density/);
  });

  it("uses no raw colours outside token declarations (token guard for usage rules)", () => {
    for (const rule of styleRules()) {
      const usage = rule.body
        .split(";")
        .filter((declaration) => !declaration.trim().startsWith("--tg-"))
        .join(";");
      expect(usage, rule.selectors.join(", ")).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i);
    }
  });

  it("colours highlighted code only with tokens that reach 4.5:1 on the code block's surface (F1)", () => {
    const used = [...new Set([...css.matchAll(/\.tg-md-code[^{]*\{[^}]*color:\s*var\((--tg-[\w-]+)\)/g)].map((match) => match[1]!))];
    expect(used.length).toBeGreaterThanOrEqual(7);
    for (const name of used) {
      for (const side of ["light", "dark"] as const) {
        expect(contrast(all.get(name)![side], all.get("--tg-surface")![side]), `${name} on surface (${side})`).toBeGreaterThanOrEqual(AA_TEXT);
      }
      expect(contrast(host.get(name)!, host.get("--tg-surface")!), `${name} on surface (host)`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("reads in the sans stack by default and in a serif only when the reader picks it, host theme included (F10 §1)", () => {
    expect(BASE).toMatch(/--tg-font-serif: var\(--tg-font-sans\);/);
    const sans = /--tg-font-sans: ([^;]+);/.exec(BASE)![1]!.split(",").map((name) => name.trim().replace(/"/g, ""));
    expect(sans[0]).toBe("Inter");
    // Our "Noto Sans TC" face has only weight 400: it must come after the Plex families or headings turn faux-bold.
    expect(sans.indexOf("Noto Sans TC")).toBeGreaterThan(sans.indexOf("IBM Plex Sans TC"));
    const own = '[data-tg-root][data-tg-reading-font="serif"]';
    const ancestor = '[data-tg-root]:is([data-tg-reading-font="serif"] *)';
    const serif = block([own, `${own} [data-tg-theme]`, ancestor, `${ancestor} [data-tg-theme]`].join(",\n"));
    expect(serif).toContain('--tg-font-serif: "Source Serif 4", "Noto Serif TC", "Songti TC", Georgia, serif;');
    // Same specificity as the host block on the root, so it must come later to win there.
    expect(css.indexOf(own)).toBeGreaterThan(css.indexOf('[data-tg-root][data-tg-theme="host"]'));
    expect(css).not.toContain("PMingLiU");
  });

  it("fixes the review's global style issues (§2 #2, #3)", () => {
    expect(css).toMatch(/\[data-tg-root\] pre\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\[data-tg-root\] \.tg-kbd-hint\s*\{\s*display:\s*none/);
  });
});
