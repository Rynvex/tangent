/**
 * The model preferences of this browser (G1; G2's Settings page builds on
 * them): the default model and reasoning effort a new conversation starts
 * with, and the favourite and hidden models the model pill (and G2's lists)
 * arrange choices by. Kept in `localStorage` as one versioned object; a
 * value that is missing, blocked, of another version or partly garbage reads
 * as far as it is valid (the rest falls back to empty).
 *
 * The store has subscribe, so every pill and the Settings page show the same
 * and another tab's change comes in.
 */
import { isReasoningEffort, modelInfo, type Capabilities } from "@tangent/client";
import { useSyncExternalStore } from "react";

export const MODEL_PREFS_KEY = "tangent:model-prefs";
export const MODEL_PREFS_VERSION = 1;
/** More favourites or hidden models than this would only be a mistake; the oldest go first. */
export const MODEL_LIST_MAX = 200;

/** A provider / model pair. */
export interface ModelRef {
  provider: string;
  model: string;
}

export interface ModelPrefs {
  /** The model a new conversation starts with; absent: the server's default. */
  defaultModel?: ModelRef;
  /** The reasoning effort a new conversation starts with (one of REASONING_EFFORTS); absent: the model's own. */
  defaultEffort?: string;
  /** Shown first in the pill, in this order. */
  favorites: readonly ModelRef[];
  /** Left out of the pill (unless the conversation uses it). */
  hidden: readonly ModelRef[];
}

export const EMPTY_MODEL_PREFS: ModelPrefs = Object.freeze({ favorites: Object.freeze([]), hidden: Object.freeze([]) });

/** The part of `Storage` used here, so tests can pass a fake. */
export interface ModelPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model);
}

function readRef(value: unknown): ModelRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { provider, model } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof model !== "string") return null;
  const ref = { provider: provider.trim(), model: model.trim() };
  return ref.provider && ref.model ? ref : null;
}

function readRefs(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return [];
  const out: ModelRef[] = [];
  for (const item of value) {
    const ref = readRef(item);
    if (ref && !out.some((seen) => sameModel(seen, ref))) out.push(ref);
  }
  return out.slice(-MODEL_LIST_MAX);
}

/** The stored value as preferences; anything unreadable is left out. */
export function parseModelPrefs(raw: string | null): ModelPrefs {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? "null");
  } catch {
    return EMPTY_MODEL_PREFS;
  }
  if (typeof value !== "object" || value === null || (value as Record<string, unknown>).version !== MODEL_PREFS_VERSION) return EMPTY_MODEL_PREFS;
  const body = value as Record<string, unknown>;
  const defaultModel = readRef(body.defaultModel);
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(isReasoningEffort(body.defaultEffort) ? { defaultEffort: body.defaultEffort } : {}),
    favorites: readRefs(body.favorites),
    hidden: readRefs(body.hidden),
  };
}

export function serializeModelPrefs(prefs: ModelPrefs): string {
  return JSON.stringify({ version: MODEL_PREFS_VERSION, ...prefs });
}

/** `prefs` with the default model set, or cleared by null. */
export function withDefaultModel(prefs: ModelPrefs, ref: ModelRef | null): ModelPrefs {
  const { defaultModel: _, ...rest } = prefs;
  const clean = readRef(ref);
  return clean ? { ...rest, defaultModel: clean } : rest;
}

/** `prefs` with the default effort set, or cleared by null (or a value that is not an effort). */
export function withDefaultEffort(prefs: ModelPrefs, effort: string | null): ModelPrefs {
  const { defaultEffort: _, ...rest } = prefs;
  return isReasoningEffort(effort) ? { ...rest, defaultEffort: effort } : rest;
}

function toggled(list: readonly ModelRef[], ref: ModelRef, on: boolean): ModelRef[] {
  const rest = list.filter((item) => !sameModel(item, ref));
  return (on ? [...rest, ref] : rest).slice(-MODEL_LIST_MAX);
}

/** `prefs` with the model a favourite (last in the order) or not. */
export function withFavorite(prefs: ModelPrefs, ref: ModelRef, on: boolean): ModelPrefs {
  return { ...prefs, favorites: toggled(prefs.favorites, ref, on) };
}

/** `prefs` with the model hidden or shown. */
export function withHidden(prefs: ModelPrefs, ref: ModelRef, on: boolean): ModelPrefs {
  return { ...prefs, hidden: toggled(prefs.hidden, ref, on) };
}

/**
 * The choices to offer: hidden ones left out (except `keep`, the model in
 * use), favourites first in their order, the rest in the server's order.
 */
export function arrangeModelChoices<T extends ModelRef>(choices: readonly T[], prefs: ModelPrefs, keep?: ModelRef | null): T[] {
  const shown = choices.filter((choice) => sameModel(choice, keep) || !prefs.hidden.some((ref) => sameModel(ref, choice)));
  const rank = (choice: T) => {
    const index = prefs.favorites.findIndex((ref) => sameModel(ref, choice));
    return index === -1 ? prefs.favorites.length : index;
  };
  return shown.map((choice, index) => ({ choice, index })).sort((a, b) => rank(a.choice) - rank(b.choice) || a.index - b.index).map((item) => item.choice);
}

/** True when the server lists the model (a server that lists none is not asked for one: it may refuse it). */
function isListed(capabilities: Capabilities | null | undefined, ref: ModelRef): boolean {
  return (capabilities?.models ?? []).some((group) => group.provider === ref.provider && group.models.includes(ref.model));
}

/** The fields of `POST /lines` (CreateLineInput) a new conversation gets from the preferences. */
export interface NewLineModel {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * What a new conversation starts with: the default model while the server
 * still lists it, and the default effort when that model takes it (without a
 * default model the effort is sent as is; the server only passes it on where
 * the model takes it).
 */
export function newLineInput(prefs: ModelPrefs, capabilities: Capabilities | null | undefined): NewLineModel {
  const model = prefs.defaultModel && isListed(capabilities, prefs.defaultModel) ? prefs.defaultModel : null;
  const effort = prefs.defaultEffort;
  const effortFits = effort !== undefined && (!model || modelInfo(capabilities, model.provider, model.model).effortLevels.includes(effort));
  return { ...(model ? { provider: model.provider, model: model.model } : {}), ...(effortFits ? { reasoningEffort: effort } : {}) };
}

export interface ModelPrefsStore {
  get(): ModelPrefs;
  /** Replaces the preferences (validated as stored). */
  set(next: ModelPrefs): void;
  subscribe(listener: () => void): () => void;
}

/** A store over `storage()`; when writing fails the change lasts until the page reloads. */
export function createModelPrefsStore(storage: () => ModelPrefsStorage | null): ModelPrefsStore {
  let current: ModelPrefs | null = null;
  const listeners = new Set<() => void>();
  const read = (): ModelPrefs => {
    try {
      return parseModelPrefs(storage()?.getItem(MODEL_PREFS_KEY) ?? null);
    } catch {
      return EMPTY_MODEL_PREFS;
    }
  };
  return {
    get: () => (current ??= read()),
    set(next) {
      const text = serializeModelPrefs(next);
      current = parseModelPrefs(text);
      try {
        storage()?.setItem(MODEL_PREFS_KEY, text);
      } catch {
        // Not kept this time; the change still shows on this page.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      // Another tab's change (`null`: it cleared all of storage).
      const onStorage = (event: StorageEvent) => {
        if (event.key !== MODEL_PREFS_KEY && event.key !== null) return;
        current = null;
        listener();
      };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };
}

function browserStorage(): ModelPrefsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The page's store. */
export const modelPrefs = createModelPrefsStore(browserStorage);

/** The preferences, re-rendering when they change. */
export function useModelPrefs(store: ModelPrefsStore = modelPrefs): ModelPrefs {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY_MODEL_PREFS);
}
