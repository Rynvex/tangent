// Lists the names a package entry file exports (values and types), sorted.
// Usage: node docs/devlog/P0/exports.mjs <entry.ts> <tsconfig.json>
// Output lines: "<name>\t<value|type>" ("value" also covers classes/enums/namespaces).
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("web/package.json"));
const ts = require("typescript");

const [entry, tsconfigPath] = process.argv.slice(2);
if (!entry || !tsconfigPath) {
  console.error("usage: node exports.mjs <entry.ts> <tsconfig.json>");
  process.exit(2);
}

const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(path.resolve(tsconfigPath)));
const program = ts.createProgram([path.resolve(entry)], { ...parsed.options, noEmit: true });
const checker = program.getTypeChecker();
const source = program.getSourceFile(path.resolve(entry));
const moduleSymbol = checker.getSymbolAtLocation(source);
if (!moduleSymbol) throw new Error("entry has no module symbol");

const VALUE_FLAGS = ts.SymbolFlags.Value;
const rows = checker.getExportsOfModule(moduleSymbol).map((sym) => {
  const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  return `${sym.getName()}\t${target.flags & VALUE_FLAGS ? "value" : "type"}`;
});
rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
process.stdout.write(rows.join("\n") + "\n");
