import { useRef } from "react";

/** True when both are the same, or objects / arrays with the same own keys and identical values. */
export function shallowEqual(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
}

/**
 * The previous value while the new one is shallowly equal, so memos that
 * depend on it hold even when a caller passes a fresh inline object or array.
 */
export function useShallowStable<T extends object | undefined>(value: T): T {
  const ref = useRef(value);
  // Idempotent per render: it only ever adopts a value that differs in content.
  if (!shallowEqual(ref.current, value)) ref.current = value;
  return ref.current;
}
