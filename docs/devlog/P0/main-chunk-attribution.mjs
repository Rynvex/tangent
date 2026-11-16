// Attributes the bytes of a built JS chunk to its source files (via the source map).
// Usage (from the repository root, after `pnpm -C web install`):
//   pnpm --filter @tangent/demo exec vite build --outDir <scratch>/dist-map --emptyOutDir --sourcemap   (run inside web/)
//   node docs/devlog/P0/main-chunk-attribution.mjs <scratch>/dist-map/assets index-<hash>.js.map > main-chunk-by-file.txt
// Output: one line per source file, "<minified bytes> <path>", biggest first, node_modules grouped by package.
// Bytes are minified (not gzip); a gzip estimate is roughly 0.33 x. Build to a scratch outDir: the repo stays clean.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const webRequire = createRequire(path.resolve("web/package.json"));
const pnpmDir = path.resolve("web/node_modules/.pnpm");
const codecDir = fs.readdirSync(pnpmDir).find((name) => name.startsWith("@jridgewell+sourcemap-codec@"));
if (!codecDir) throw new Error("@jridgewell/sourcemap-codec not found in web/node_modules/.pnpm");
const codec = webRequire(path.join(pnpmDir, codecDir, "node_modules/@jridgewell/sourcemap-codec"));

const [dir, mapFile] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(path.join(dir, mapFile), "utf8"));
const lines = fs.readFileSync(path.join(dir, mapFile.replace(/\.map$/, "")), "utf8").split("\n");
const bytes = new Map();
codec.decode(map.mappings).forEach((segments, lineIndex) => {
  const line = lines[lineIndex] ?? "";
  segments.forEach((segment, index) => {
    if (segment.length < 4) return;
    const end = index + 1 < segments.length ? segments[index + 1][0] : line.length;
    const source = map.sources[segment[1]];
    bytes.set(source, (bytes.get(source) ?? 0) + end - segment[0]);
  });
});
const label = (source) => {
  const pkg = source.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (pkg) return `node_modules/${pkg[1]}`;
  return source.replace(/^.*?\/web\//, "").replace(/^(\.\.\/)+/, "");
};
const grouped = new Map();
for (const [source, size] of bytes) grouped.set(label(source), (grouped.get(label(source)) ?? 0) + size);
for (const [name, size] of [...grouped].sort((a, b) => b[1] - a[1])) console.log(`${String(size).padStart(7)} ${name}`);
