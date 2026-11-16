import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "package.json"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; exports: Record<string, string> };
const OUTPUTS = ["latin.css", "tc.css", "serif.css", "host.css", "NOTICES"];

interface Face {
  family: string;
  weight: string;
  style: string;
  display: string;
  url: string;
  /** The `local()` names before the url, in order. */
  locals: string[];
  unicodeRange: string;
}

function parse(css: string): Face[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => {
    const get = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(match[1]!)?.[1]?.trim() ?? "";
    return {
      family: get("font-family").replace(/"/g, ""),
      weight: get("font-weight"),
      style: get("font-style"),
      display: get("font-display"),
      url: /^(?:local\("[^"]+"\), )*url\("([^"]+)"\) format\("woff2"\)$/.exec(get("src"))?.[1] ?? "",
      locals: [...get("src").matchAll(/local\("([^"]+)"\)/g)].map((local) => local[1]!),
      unicodeRange: get("unicode-range"),
    };
  });
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Each entry's families and the weights they may ship (prototype: sans 400/500/600, mono 400/500, serif 400/600). */
const ENTRIES: Record<string, Record<string, string[]>> = {
  "latin.css": { "IBM Plex Sans": ["400", "500", "600"], "IBM Plex Mono": ["400", "500"] },
  "tc.css": { "IBM Plex Sans TC": ["400", "500", "600"], "Noto Sans TC": ["400"] },
  "serif.css": { "Source Serif 4": ["400", "600"], "Noto Serif TC": ["400", "600"] },
  "host.css": { Geist: ["400", "500", "600"], "Geist Mono": ["400", "500"] },
};
const CJK = ["IBM Plex Sans TC", "Noto Serif TC", "Noto Sans TC"];

/** The system faces each CJK face tries before its download, in order (F9 B.3); Latin faces try none. */
const SANS_TC_LOCALS = ["PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", "Heiti TC", "Microsoft JhengHei"];
const PINGFANG: Record<string, string> = { "400": "PingFangTC-Regular", "500": "PingFangTC-Medium", "600": "PingFangTC-Semibold" };
const expectedLocals = (family: string, weight: string): string[] => {
  if (family === "Noto Serif TC") return ["Songti TC", "Noto Serif CJK TC"];
  if (family === "IBM Plex Sans TC" || family === "Noto Sans TC") return [PINGFANG[weight]!, ...SANS_TC_LOCALS];
  return [];
};

describe("@tangent/fonts build output", () => {
  const temp = mkdtempSync(join(tmpdir(), "tangent-fonts-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it("is exactly what scripts/build.mjs generates now (committed output is not stale)", () => {
    const run = spawnSync(process.execPath, [join(ROOT, "scripts", "build.mjs"), temp], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    for (const file of OUTPUTS) expect(readFileSync(join(temp, file), "utf8"), file).toBe(read(file));
  });

  it("exports every entry", () => {
    for (const file of OUTPUTS) expect(pkg.exports[`./${file}`]).toBe(`./${file}`);
  });

  it.each(Object.entries(ENTRIES))("%s ships its families with only the weights the UI uses", (file, families) => {
    const faces = parse(read(file));
    expect(new Set(faces.map((face) => face.family))).toEqual(new Set(Object.keys(families)));
    for (const [family, weights] of Object.entries(families)) {
      const shipped = new Set(faces.filter((face) => face.family === family).map((face) => face.weight));
      expect([...shipped].sort(), family).toEqual([...weights].sort());
    }
    for (const face of faces) expect(face.style).toBe("normal");
  });

  it("points every url at an existing woff2 file of a declared dependency, with swap and a unicode-range", () => {
    const dependencies = Object.keys(pkg.dependencies);
    for (const file of Object.keys(ENTRIES)) {
      for (const face of parse(read(file))) {
        expect(face.display).toBe("swap");
        expect(face.unicodeRange, `${face.family} ${face.url}`).not.toBe("");
        const owner = dependencies.find((name) => face.url.startsWith(`${name}/`));
        expect(owner, face.url).toBeDefined();
        const path = join(dirname(require.resolve(`${owner}/package.json`)), face.url.slice(owner!.length + 1));
        expect(existsSync(path), path).toBe(true);
        expect(path).toMatch(/\.woff2$/);
      }
    }
  });

  it("splits CJK families into unicode-range slices (no whole-font downloads)", () => {
    const faces = Object.keys(ENTRIES).flatMap((file) => parse(read(file)));
    for (const family of CJK) expect(faces.filter((face) => face.family === family).length, family).toBeGreaterThan(50);
  });

  it("tries the system CJK faces before downloading, and only for CJK faces", () => {
    for (const file of Object.keys(ENTRIES)) {
      for (const face of parse(read(file))) {
        expect(face.url, `${face.family} ${face.weight}`).not.toBe("");
        expect(face.locals, `${file} ${face.family} ${face.weight}`).toEqual(expectedLocals(face.family, face.weight));
      }
    }
    const semibold = parse(read("tc.css")).find((face) => face.family === "IBM Plex Sans TC" && face.weight === "600");
    expect(semibold?.locals[0]).toBe("PingFangTC-Semibold");
  });

  it("lists every font package with its license and copyright in NOTICES", () => {
    const notices = read("NOTICES");
    for (const name of Object.keys(pkg.dependencies)) expect(notices, name).toMatch(new RegExp(`${name.replace("/", "\\/")} [\\d.]+\\nLicense: OFL-1\\.1\\n  \\S`));
    expect(notices).toContain("Copyright © 2017 IBM Corp.");
  });
});
