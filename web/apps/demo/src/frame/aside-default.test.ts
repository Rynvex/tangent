import { describe, expect, it } from "vitest";
import { ASIDE_DEFAULT_KEY, keepsAsides, type AsideDefaultStorage } from "./aside-default";
import { ASIDE_DEFAULT_MAX, createAsideDefaultStore, parseAsideKeepers, withAsideDefault } from "./aside-default-store";

function fakeStorage(initial: Record<string, string> = {}): AsideDefaultStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe("a conversation's default for its quick questions (F18 §2.2)", () => {
  it("is 用完即丟 until the conversation is set to keep, per main line", () => {
    const storage = fakeStorage();
    const store = createAsideDefaultStore(() => storage);
    expect(keepsAsides("root-a", storage)).toBe(false);
    store.set("root-a", "keep");
    expect(keepsAsides("root-a", storage)).toBe(true);
    expect(keepsAsides("root-b", storage)).toBe(false);
    expect(JSON.parse(storage.data[ASIDE_DEFAULT_KEY]!)).toEqual(["root-a"]);
    store.set("root-a", "discard");
    expect(keepsAsides("root-a", storage)).toBe(false);
    expect(JSON.parse(storage.data[ASIDE_DEFAULT_KEY]!)).toEqual([]);
  });

  it("tells every subscriber, and reads the stored value once", () => {
    const storage = fakeStorage({ [ASIDE_DEFAULT_KEY]: JSON.stringify(["root-a"]) });
    const store = createAsideDefaultStore(() => storage);
    let told = 0;
    const stop = store.subscribe(() => (told += 1));
    expect(store.get()).toEqual(["root-a"]);
    store.set("root-b", "keep");
    expect(told).toBe(1);
    expect(store.get()).toEqual(["root-a", "root-b"]);
    stop();
    store.set("root-c", "keep");
    expect(told).toBe(1);
  });

  it("reads garbage, a blocked storage and no conversation as the default", () => {
    expect(parseAsideKeepers("{not json")).toEqual([]);
    expect(parseAsideKeepers(JSON.stringify({ a: 1 }))).toEqual([]);
    expect(parseAsideKeepers(JSON.stringify(["a", 3, "", "a", "b"]))).toEqual(["a", "b"]);
    expect(keepsAsides(null, fakeStorage())).toBe(false);
    expect(keepsAsides("root-a", null)).toBe(false);
    const blocked: AsideDefaultStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(keepsAsides("root-a", blocked)).toBe(false);
    const store = createAsideDefaultStore(() => blocked);
    store.set("root-a", "keep");
    // Not written, but the choice holds on this page.
    expect(store.get()).toEqual(["root-a"]);
  });

  it("keeps at most ASIDE_DEFAULT_MAX conversations, dropping the oldest", () => {
    const many = Array.from({ length: ASIDE_DEFAULT_MAX }, (_, index) => `r${index}`);
    const next = withAsideDefault(many, "new", "keep");
    expect(next).toHaveLength(ASIDE_DEFAULT_MAX);
    expect(next[0]).toBe("r1");
    expect(next.at(-1)).toBe("new");
  });
});
