#!/usr/bin/env node
/**
 * Generates the entry files of @tangent/fonts from the font packages' own
 * @font-face rules: `node scripts/build.mjs [outDir]` (default: the package
 * root). Keeps only the weights the UI uses, only woff2, only unicode-range
 * subsets (CJK faces are split into ~100–200 slices so a page downloads the
 * glyphs it shows), adds `font-display: swap`, lets CJK faces try installed
 * system faces first (`local()`), and points every url at the
 * font package (`@ibm/plex-sans/...`), which the host's bundler resolves from
 * this package's dependencies. Also writes NOTICES (copyright and license of
 * every font package, read from its package.json and LICENSE file).
 *
 * Entries: latin.css (Plex Sans / Mono), tc.css (Plex Sans TC + Noto Sans TC
 * fallback), serif.css (Source Serif 4 + Noto Serif TC), host.css (Geist).
 * Output is deterministic; src/build.test.ts regenerates and diffs it.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const OUT = resolve(process.argv[2] ?? join(here, ".."));

/** Absolute path of a file inside an installed package. */
function packageFile(pkg, file) {
  return join(dirname(require.resolve(`${pkg}/package.json`)), file);
}

/** Parses every @font-face block with the comment right before it (fontsource names its subsets there). */
function faces(css) {
  const result = [];
  const pattern = /(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const props = {};
    for (const declaration of match[2].split(";")) {
      const at = declaration.indexOf(":");
      if (at < 0) continue;
      props[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim();
    }
    result.push({ label: match[1] ?? "", props });
  }
  return result;
}

/** The first woff2 url of a `src` list. */
function woff2(src) {
  const match = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/.exec(src);
  if (!match) throw new Error(`no woff2 source in ${src}`);
  return match[1];
}

/** Joins a relative url onto a package-relative directory: ("../fonts/x", "css") → "fonts/x". */
function resolveRelative(dir, url) {
  const parts = dir ? dir.split("/") : [];
  for (const segment of url.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** PingFang TC's PostScript names by weight (local() matches a face's full or PostScript name). */
const PINGFANG_BY_WEIGHT = { 400: "PingFangTC-Regular", 500: "PingFangTC-Medium", 600: "PingFangTC-Semibold" };

/**
 * System CJK faces tried before the download (F9 B.3): most macOS, iOS,
 * Windows and Linux desktops already have a Traditional Chinese face, so the
 * slices are fetched only where none is installed. Their metrics differ a
 * little from Plex Sans TC / Noto Serif TC.
 */
const LOCAL_SANS_TC = (weight) => [PINGFANG_BY_WEIGHT[weight], "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Heiti TC", "Microsoft JhengHei"].filter(Boolean);
const LOCAL_SERIF_TC = () => ["Songti TC", "Noto Serif CJK TC"];

/**
 * Each source: a package, the CSS files to read (package-relative), which
 * faces to keep, the family name to emit, and (CJK only) the system faces
 * `local()` tries first, by weight.
 */
const SOURCES = [
  {
    family: "IBM Plex Sans",
    entry: "latin",
    pkg: "@ibm/plex-sans",
    files: ["Regular", "Medium", "SemiBold"].map((w) => `fonts/split/woff2/IBMPlexSans-${w}.css`),
    keep: (face) => /Latin[123]|Pi/.test(face.props.src),
  },
  {
    family: "IBM Plex Mono",
    entry: "latin",
    pkg: "@ibm/plex-mono",
    files: ["Regular", "Medium"].map((w) => `fonts/split/woff2/IBMPlexMono-${w}.css`),
    keep: (face) => /Latin[123]|Pi/.test(face.props.src),
  },
  {
    family: "IBM Plex Sans TC",
    local: LOCAL_SANS_TC,
    entry: "tc",
    pkg: "@ibm/plex-sans-tc",
    files: ["css/ibm-plex-sans-tc-all.css"],
    keep: (face) => face.props.src.includes("/split/") && ["400", "500", "600"].includes(face.props["font-weight"]),
  },
  {
    family: "Source Serif 4",
    entry: "serif",
    pkg: "@fontsource/source-serif-4",
    files: ["400.css", "600.css"],
    keep: (face) => /-latin(-ext)?-\d+-normal$/.test(face.label),
  },
  {
    family: "Noto Serif TC",
    local: LOCAL_SERIF_TC,
    entry: "serif",
    pkg: "@fontsource/noto-serif-tc",
    files: ["400.css", "600.css"],
    keep: (face) => /\[\d+\]/.test(face.label),
  },
  {
    // Glyph fallback only (IBM Plex Sans TC covers the weights), so one weight.
    family: "Noto Sans TC",
    local: LOCAL_SANS_TC,
    entry: "tc",
    pkg: "@fontsource/noto-sans-tc",
    files: ["400.css"],
    keep: (face) => /\[\d+\]/.test(face.label),
  },
  {
    family: "Geist",
    entry: "host",
    pkg: "@fontsource/geist-sans",
    files: ["400.css", "500.css", "600.css"],
    keep: () => true,
  },
  {
    family: "Geist Mono",
    entry: "host",
    pkg: "@fontsource/geist-mono",
    files: ["400.css", "500.css"],
    keep: (face) => /-latin(-ext)?-\d+-normal$/.test(face.label),
  },
];

/**
 * fontsource's Latin range, for faces that ship without one (Geist): without
 * a range the browser would ask the Latin font for CJK punctuation first.
 */
const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

function render(source, fileDir, face) {
  const { family, pkg } = source;
  const url = `${pkg}/${resolveRelative(fileDir, woff2(face.props.src))}`;
  const locals = (source.local?.(face.props["font-weight"]) ?? []).map((name) => `local("${name}")`);
  const lines = [
    `  font-family: "${family}";`,
    `  font-style: ${face.props["font-style"] ?? "normal"};`,
    `  font-weight: ${face.props["font-weight"]};`,
    "  font-display: swap;",
    `  src: ${[...locals, `url("${url}") format("woff2")`].join(", ")};`,
  ];
  lines.push(`  unicode-range: ${(face.props["unicode-range"] ?? LATIN_RANGE).replace(/\s+/g, "")};`);
  return `@font-face {\n${lines.join("\n")}\n}`;
}

const ENTRIES = {
  latin: "IBM Plex Sans and IBM Plex Mono, Latin subsets",
  tc: "IBM Plex Sans TC, with Noto Sans TC (400) for missing glyphs",
  serif: "Source Serif 4 and Noto Serif TC, for long AI answers",
  host: "Geist and Geist Mono, for the tangent host theme",
};

/** Rendered faces per entry, with what the output order needs. */
const rendered = Object.fromEntries(Object.keys(ENTRIES).map((entry) => [entry, []]));
const summary = Object.fromEntries(Object.keys(ENTRIES).map((entry) => [entry, []]));
for (const source of SOURCES) {
  let count = 0;
  for (const file of source.files) {
    const css = readFileSync(packageFile(source.pkg, file), "utf8");
    const fileDir = dirname(file) === "." ? "" : dirname(file);
    for (const face of faces(css)) {
      if (face.props["font-style"] === "italic" || !source.keep(face)) continue;
      rendered[source.entry].push({ range: face.props["unicode-range"] ?? LATIN_RANGE, css: render(source, fileDir, face) });
      count += 1;
    }
  }
  if (count === 0) throw new Error(`no faces kept for ${source.family}`);
  summary[source.entry].push(`${source.family} ${count}`);
}

mkdirSync(OUT, { recursive: true });
for (const [entry, description] of Object.entries(ENTRIES)) {
  const header = `/*
 * @tangent/fonts/${entry}.css: ${description}. SIL OFL 1.1 (see NOTICES).
 * GENERATED by scripts/build.mjs; do not edit by hand.
 * Faces: ${summary[entry].join(", ")}. Every face is woff2 with font-display: swap
 * and a unicode-range, so a page downloads only the files of the glyphs it shows.
 */
`;
  /*
   * Faces with the same unicode-range (the weights of one family, and the Noto
   * families, which share fontsource's slicing) are written next to each other
   * so gzip's 32 KB window can fold the repeated range lists. Order does not
   * change the result: within one family, weight and style the slices never
   * overlap. Stable sort keeps the source order otherwise.
   */
  const blocks = [...rendered[entry]].sort((a, b) => (a.range === b.range ? 0 : a.range < b.range ? -1 : 1)).map((face) => face.css);
  writeFileSync(join(OUT, `${entry}.css`), `${header}\n${blocks.join("\n\n")}\n`);
}

/** The copyright lines a font package's LICENSE puts above the OFL text. */
function copyright(pkg) {
  const dir = dirname(require.resolve(`${pkg}/package.json`));
  const file = readdirSync(dir).find((name) => /^(licen[cs]e|ofl)/i.test(name));
  if (!file) throw new Error(`${pkg} ships no LICENSE file`);
  const text = readFileSync(join(dir, file), "utf8");
  const preamble = text.split(/This Font Software is licensed/i)[0] ?? "";
  const lines = preamble.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`${pkg}: no copyright line before the license text`);
  return lines;
}

const notices = [...new Set(SOURCES.map((source) => source.pkg))].map((pkg) => {
  const manifest = JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), "utf8"));
  const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
  if (!license) throw new Error(`${pkg} has no license field`);
  return [`${pkg} ${manifest.version}`, `License: ${license}`, ...copyright(pkg).map((line) => `  ${line}`)].join("\n");
});
writeFileSync(
  join(OUT, "NOTICES"),
  `Third-party fonts bundled by @tangent/fonts. GENERATED by scripts/build.mjs.\nEach is licensed under the SIL Open Font License 1.1: https://openfontlicense.org\n\n${notices.join("\n\n")}\n`,
);
console.log(`wrote ${Object.keys(ENTRIES).map((entry) => `${entry}.css (${summary[entry].join(", ")})`).join("; ")} and NOTICES to ${OUT}`);
