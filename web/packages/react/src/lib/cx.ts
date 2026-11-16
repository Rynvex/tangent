/** Joins class names, skipping falsy parts. Components append the caller's `className` last. */
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
