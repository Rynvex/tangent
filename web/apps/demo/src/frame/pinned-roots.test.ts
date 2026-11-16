import { describe, expect, it, vi } from "vitest";
import { createPinnedStore, parsePinned, PINNED_ROOTS_KEY, PINNED_ROOTS_MAX, togglePinned, type PinnedStorage } from "./pinned-roots";

/** F8 S5: conversations pinned in this browser only. */

function memory(initial: Record<string, string> = {}): PinnedStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe("parsePinned", () => {
  it("reads ids in pin order, without duplicates or junk", () => {
    expect(parsePinned('["a","b","a",3,"",null,"c"]')).toEqual(["a", "b", "c"]);
  });

  it("reads anything unreadable as nothing pinned", () => {
    for (const raw of [null, "", "{", '{"a":1}', "42", '"a"']) expect(parsePinned(raw)).toEqual([]);
  });

  it("keeps at most the newest PINNED_ROOTS_MAX", () => {
    const ids = Array.from({ length: PINNED_ROOTS_MAX + 5 }, (_, n) => `l${n}`);
    expect(parsePinned(JSON.stringify(ids))).toEqual(ids.slice(5));
  });
});

describe("togglePinned", () => {
  it("pins at the end (newest last) and unpins", () => {
    expect(togglePinned(["a", "b"], "a", true)).toEqual(["b", "a"]);
    expect(togglePinned(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
    expect(togglePinned(["a", "b"], "a", false)).toEqual(["b"]);
    expect(togglePinned(["a"], "x", false)).toEqual(["a"]);
  });
});

describe("createPinnedStore", () => {
  it("writes the key, tells subscribers and keeps the same list until it changes", () => {
    const storage = memory({ [PINNED_ROOTS_KEY]: '["a"]' });
    const store = createPinnedStore(() => storage);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const first = store.get();
    expect(first).toEqual(["a"]);
    expect(store.get()).toBe(first);
    store.set("b", true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(["a", "b"]);
    expect(JSON.parse(storage.data[PINNED_ROOTS_KEY]!)).toEqual(["a", "b"]);
    off();
    store.set("a", false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(["b"]);
  });

  it("works with blocked storage: nothing read, pins last for the page", () => {
    const blocked: PinnedStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    const store = createPinnedStore(() => blocked);
    expect(store.get()).toEqual([]);
    store.set("a", true);
    expect(store.get()).toEqual(["a"]);
    expect(createPinnedStore(() => null).get()).toEqual([]);
  });

  it("reads corrupt storage as nothing pinned", () => {
    expect(createPinnedStore(() => memory({ [PINNED_ROOTS_KEY]: "not json" })).get()).toEqual([]);
  });
});
