/** Joins class names, skipping falsy parts (the package's own `cx` is internal). */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
