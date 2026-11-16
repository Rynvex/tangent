/**
 * `normalizeBaseUrl` on its own (re-exported by `api.ts`, so every import path stays the same).
 * `@tangent/react` builds its query keys with it in the main chunk; while it lived in `api.ts`,
 * that one function kept `api.ts` — `createTangentClient` and every route's normalizer with it —
 * in the main chunk of a host that loads the client lazily (F20b).
 */

/** Removes trailing slashes so `"/api/"` and `"/api"` behave the same. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
