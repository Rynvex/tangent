/**
 * Test helper (not exported): reads the contract samples the Go side writes
 * to `httpapi/testdata/contract/` (B4d). They are the only source of truth for
 * the wire shapes; see docs/devlog/B4-contract-diff.md.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `TANGENT_CONTRACT_DIR` points the tests at another copy of the samples (e.g.
 * a commit's, while the backend is regenerating the working tree's), with or
 * without a trailing slash.
 */
const DIR = process.env.TANGENT_CONTRACT_DIR ?? fileURLToPath(new URL("../../../../httpapi/testdata/contract/", import.meta.url));
/** With a trailing slash whether or not the variable had one. */
export const CONTRACT_DIR = DIR.endsWith("/") ? DIR : `${DIR}/`;

export interface RouteSample {
  name: string;
  method: string;
  path: string;
  status: number;
  request?: unknown;
  response?: unknown;
}

export interface EventSample {
  name: string;
  type: string;
  tenant: string;
  rootLineId: string;
  lineId: string;
  data: unknown;
}

/** Every sample file name without `.json`, sorted. */
export function sampleNames(): string[] {
  return readdirSync(CONTRACT_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

function read(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${CONTRACT_DIR}${name}.json`, "utf8")) as Record<string, unknown>;
}

export function routeSample(name: string): RouteSample {
  const raw = read(name);
  return { name, method: String(raw.method), path: String(raw.path), status: Number(raw.status), request: raw.request, response: raw.response };
}

export function eventSample(name: string): EventSample {
  const raw = read(name);
  return {
    name,
    type: String(raw.type),
    tenant: String(raw.tenant),
    rootLineId: String(raw.rootLineId),
    lineId: String(raw.lineId),
    data: raw.data,
  };
}

export const routeSampleNames = (): string[] => sampleNames().filter((name) => name.startsWith("route."));
export const eventSampleNames = (): string[] => sampleNames().filter((name) => name.startsWith("event."));

/** The UUIDs of a sample path, in order (the path ids a client call needs). */
export function pathIds(path: string): string[] {
  return path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
}

/**
 * Keys whose content is free-form: the host's and the library's meta, and a
 * suggestion's `payload` and an accept's `result`, which are each feature's own
 * (a probe's and a rebalance suggestion's differ).
 */
const FREE_FORM_KEYS = new Set(["meta", "hostMeta", "payload", "result"]);

/**
 * Compares the shape of `actual` with `expected`: the same object keys at
 * every level (the contents of FREE_FORM_KEYS excepted), the same
 * primitive types (null matches anything: nullable fields such as
 * `closedAt` or `draft.card`), arrays by their first element (an empty array
 * matches any array). Returns the paths that differ.
 */
export function shapeDiff(actual: unknown, expected: unknown, path = "$"): string[] {
  const kind = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
  if (actual === null || expected === null) return [];
  if (kind(actual) !== kind(expected)) return [`${path}: ${kind(actual)} != ${kind(expected)}`];
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length === 0 || expected.length === 0) return [];
    return shapeDiff(actual[0], expected[0], `${path}[0]`);
  }
  if (kind(actual) !== "object") return [];
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
  const diffs: string[] = [];
  for (const key of keys) {
    if (!(key in a)) diffs.push(`${path}.${key}: missing`);
    else if (!(key in e)) diffs.push(`${path}.${key}: extra`);
    else if (!FREE_FORM_KEYS.has(key)) diffs.push(...shapeDiff(a[key], e[key], `${path}.${key}`));
  }
  return diffs;
}
