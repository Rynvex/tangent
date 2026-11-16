/**
 * Primitive readers for untrusted JSON. Every response body and event payload
 * passes through a normalizer built from these, so a Go nil slice (`null`), a
 * missing field or a wrong type never reaches the UI as `undefined`.
 */
import type { JsonValue } from "./types";

export type WireObject = Readonly<Record<string, unknown>>;

const EMPTY: WireObject = Object.freeze({});

/** The value as an object, or an empty one. */
export function obj(value: unknown): WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as WireObject) : EMPTY;
}

/** True when the value is a plain JSON object. */
export function isObject(value: unknown): value is WireObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A string, or null when absent or not a string (for `*time.Time`). */
export function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A finite number that is not negative; counts and seqs. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function bool(value: unknown): boolean {
  return value === true;
}

/** Maps each item of an array; anything else (null included) is an empty list. */
export function list<T>(value: unknown, item: (raw: unknown, index: number) => T): T[] {
  return Array.isArray(value) ? value.map(item) : [];
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The value when it is one of `allowed`, else `fallback`. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Host-owned JSON, kept as-is; `undefined` (absent) becomes `{}`. */
export function json(value: unknown): JsonValue {
  return value === undefined ? {} : (value as JsonValue);
}
