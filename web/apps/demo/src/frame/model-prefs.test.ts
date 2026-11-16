import { normalizeCapabilities } from "@tangent/client";
import { describe, expect, it, vi } from "vitest";
import {
  arrangeModelChoices,
  createModelPrefsStore,
  EMPTY_MODEL_PREFS,
  MODEL_LIST_MAX,
  MODEL_PREFS_KEY,
  newLineInput,
  parseModelPrefs,
  sameModel,
  serializeModelPrefs,
  withDefaultEffort,
  withDefaultModel,
  withFavorite,
  withHidden,
  type ModelPrefsStorage,
} from "./model-prefs";

const opus = { provider: "claude-cli", model: "claude-opus-5-5" };
const haiku = { provider: "claude-cli", model: "claude-haiku-5-5" };
const sol = { provider: "codex-cli", model: "gpt-6.1-sol" };

function memoryStorage(initial?: string): ModelPrefsStorage & { data: Record<string, string> } {
  const data: Record<string, string> = initial === undefined ? {} : { [MODEL_PREFS_KEY]: initial };
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe("parseModelPrefs", () => {
  it("reads a stored value and round-trips through serializeModelPrefs", () => {
    const prefs = { defaultModel: opus, defaultEffort: "high", favorites: [sol], hidden: [haiku] };
    expect(parseModelPrefs(serializeModelPrefs(prefs))).toStrictEqual(prefs);
    expect(JSON.parse(serializeModelPrefs(prefs))).toMatchObject({ version: 1 });
  });

  it("falls back to empty for missing, broken or other-version values", () => {
    for (const raw of [null, "", "{", "[]", "3", JSON.stringify({ version: 2, defaultModel: opus }), JSON.stringify({ defaultModel: opus })]) {
      expect(parseModelPrefs(raw)).toStrictEqual(EMPTY_MODEL_PREFS);
    }
  });

  it("keeps what is valid and drops the rest", () => {
    const raw = JSON.stringify({
      version: 1,
      defaultModel: { provider: " claude-cli ", model: "" },
      defaultEffort: "ultra",
      favorites: [sol, sol, { provider: "x" }, "junk", { provider: " codex-cli ", model: " gpt-6-luna " }],
      hidden: "nope",
    });
    expect(parseModelPrefs(raw)).toStrictEqual({ favorites: [sol, { provider: "codex-cli", model: "gpt-6-luna" }], hidden: [] });
  });

  it("keeps at most MODEL_LIST_MAX models, the newest", () => {
    const many = Array.from({ length: MODEL_LIST_MAX + 5 }, (_, index) => ({ provider: "p", model: `m${index}` }));
    const parsed = parseModelPrefs(JSON.stringify({ version: 1, favorites: many, hidden: [] }));
    expect(parsed.favorites).toHaveLength(MODEL_LIST_MAX);
    expect(parsed.favorites[0]).toEqual({ provider: "p", model: "m5" });
  });
});

describe("preference updates", () => {
  it("sets and clears the defaults without touching the rest", () => {
    const base = withFavorite(EMPTY_MODEL_PREFS, sol, true);
    const set = withDefaultEffort(withDefaultModel(base, opus), "max");
    expect(set).toStrictEqual({ favorites: [sol], hidden: [], defaultModel: opus, defaultEffort: "max" });
    expect(withDefaultEffort(withDefaultModel(set, null), null)).toStrictEqual({ favorites: [sol], hidden: [] });
    expect(withDefaultEffort(set, "ultra")).not.toHaveProperty("defaultEffort");
    expect(withDefaultModel(set, { provider: "", model: "x" })).not.toHaveProperty("defaultModel");
    expect(base.favorites).toEqual([sol]);
  });

  it("toggles favourites (newest last) and hidden models", () => {
    let prefs = withFavorite(withFavorite(EMPTY_MODEL_PREFS, sol, true), opus, true);
    expect(prefs.favorites).toEqual([sol, opus]);
    prefs = withFavorite(withFavorite(prefs, sol, false), sol, true);
    expect(prefs.favorites).toEqual([opus, sol]);
    prefs = withHidden(prefs, haiku, true);
    expect(prefs.hidden).toEqual([haiku]);
    expect(withHidden(prefs, { ...haiku }, false).hidden).toEqual([]);
    expect(EMPTY_MODEL_PREFS.favorites).toEqual([]);
  });

  it("compares models by provider and name", () => {
    expect(sameModel(opus, { ...opus })).toBe(true);
    expect(sameModel(opus, { provider: "anthropic", model: opus.model })).toBe(false);
    expect(sameModel(null, opus)).toBe(false);
  });
});

describe("arrangeModelChoices", () => {
  const choices = [opus, haiku, sol, { provider: "anthropic", model: "claude-haiku-4-5" }];
  it("leaves hidden models out, except the one in use, and puts favourites first in their order", () => {
    const prefs = withHidden(withFavorite(withFavorite(EMPTY_MODEL_PREFS, sol, true), haiku, true), opus, true);
    expect(arrangeModelChoices(choices, prefs)).toEqual([sol, haiku, { provider: "anthropic", model: "claude-haiku-4-5" }]);
    expect(arrangeModelChoices(choices, prefs, opus)).toEqual([sol, haiku, opus, { provider: "anthropic", model: "claude-haiku-4-5" }]);
  });

  it("keeps the server's order without preferences", () => {
    expect(arrangeModelChoices(choices, EMPTY_MODEL_PREFS)).toEqual(choices);
  });
});

describe("newLineInput", () => {
  const caps = normalizeCapabilities({
    features: [],
    models: [{ provider: "claude-cli", models: [opus.model, haiku.model], details: [{ model: opus.model, effortLevels: ["low", "medium", "high", "max"] }] }],
  });

  it("starts with the default model and an effort it takes", () => {
    const prefs = withDefaultEffort(withDefaultModel(EMPTY_MODEL_PREFS, opus), "high");
    expect(newLineInput(prefs, caps)).toStrictEqual({ provider: "claude-cli", model: "claude-opus-5-5", reasoningEffort: "high" });
  });

  it("leaves out an effort the model does not take", () => {
    expect(newLineInput(withDefaultEffort(withDefaultModel(EMPTY_MODEL_PREFS, haiku), "high"), caps)).toStrictEqual({ provider: "claude-cli", model: "claude-haiku-5-5" });
  });

  it("asks for nothing the server no longer lists, and sends the effort alone without a default model", () => {
    expect(newLineInput(withDefaultModel(EMPTY_MODEL_PREFS, sol), caps)).toStrictEqual({});
    expect(newLineInput(withDefaultModel(EMPTY_MODEL_PREFS, opus), normalizeCapabilities({ features: [] }))).toStrictEqual({});
    expect(newLineInput(withDefaultEffort(EMPTY_MODEL_PREFS, "low"), caps)).toStrictEqual({ reasoningEffort: "low" });
    expect(newLineInput(EMPTY_MODEL_PREFS, caps)).toStrictEqual({});
  });
});

describe("createModelPrefsStore", () => {
  it("reads storage once, writes the versioned value and tells listeners", () => {
    const storage = memoryStorage(serializeModelPrefs(withDefaultModel(EMPTY_MODEL_PREFS, opus)));
    const store = createModelPrefsStore(() => storage);
    expect(store.get().defaultModel).toEqual(opus);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set(withDefaultEffort(store.get(), "max"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(parseModelPrefs(storage.data[MODEL_PREFS_KEY] ?? null)).toStrictEqual({ defaultModel: opus, defaultEffort: "max", favorites: [], hidden: [] });
    expect(store.get()).toBe(store.get());
    unsubscribe();
    store.set(EMPTY_MODEL_PREFS);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("works with blocked or failing storage: empty to start, changes last for the page", () => {
    const failing: ModelPrefsStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const store = createModelPrefsStore(() => failing);
    expect(store.get()).toStrictEqual(EMPTY_MODEL_PREFS);
    store.set(withFavorite(EMPTY_MODEL_PREFS, sol, true));
    expect(store.get().favorites).toEqual([sol]);
    expect(createModelPrefsStore(() => null).get()).toStrictEqual(EMPTY_MODEL_PREFS);
  });

  it("validates what it is given, like what it reads", () => {
    const store = createModelPrefsStore(() => memoryStorage());
    store.set({ favorites: [sol, sol], hidden: [], defaultEffort: "ultra" });
    expect(store.get()).toStrictEqual({ favorites: [sol], hidden: [] });
  });
});
