/**
 * Notes reads beyond the list itself (A9): the notes block the next turn
 * would carry (from `POST /preview`, shared with the send preview's cache),
 * and when the viewer last looked at the page (for "新").
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTangent } from "../provider";

export interface NotesBlock {
  /** The block's text exactly as the prompt carries it. */
  content: string;
  tokens: number;
}

/**
 * The `notes` block of the next turn on `lineId` (an empty draft), or null
 * when the prompt carries none (no active notes). Same query as
 * `usePreview(lineId, "")`; note writes and `notes.changed` refresh it.
 */
export function useNotesBlock(lineId: string | null, enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.preview(lineId ?? "", ""),
    queryFn: ({ signal }) => client.previewTurn(lineId ?? "", { content: "" }, { signal }),
    enabled: enabled && lineId !== null,
    select: (preview): NotesBlock | null => {
      const block = preview.blocks.find((item) => item.key === "notes");
      return block ? { content: block.content, tokens: block.tokens } : null;
    },
  });
}

/** Where the time of each viewer's last visit to a conversation's notes is kept. */
export interface NotesSeenStore {
  get(scope: string, rootLineId: string): string | null;
  set(scope: string, rootLineId: string, at: string): void;
}

const STORAGE_PREFIX = "tangent.notesSeen";

/**
 * The default store: the browser's localStorage. Unavailable storage (private
 * windows, blocked site data) just means nothing is marked new.
 */
export const localNotesSeen: NotesSeenStore = {
  get(scope, rootLineId) {
    try {
      return globalThis.localStorage?.getItem(`${STORAGE_PREFIX}:${scope}:${rootLineId}`) ?? null;
    } catch {
      return null;
    }
  },
  set(scope, rootLineId, at) {
    try {
      globalThis.localStorage?.setItem(`${STORAGE_PREFIX}:${scope}:${rootLineId}`, at);
    } catch {
      // Not remembered this time; the page still works.
    }
  },
};

/** An in-memory store (tests, hosts that keep it elsewhere): `{ scope: { rootLineId: time } }`. */
export function createMemoryNotesSeen(initial: Readonly<Record<string, Readonly<Record<string, string>>>> = {}): NotesSeenStore {
  let data = initial;
  return {
    get: (scope, rootLineId) => data[scope]?.[rootLineId] ?? null,
    set: (scope, rootLineId, at) => {
      data = { ...data, [scope]: { ...data[scope], [rootLineId]: at } };
    },
  };
}

export interface NotesSeenOptions {
  store?: NotesSeenStore;
  now?: () => string;
}

/**
 * The time of the viewer's previous visit to this conversation's notes, or
 * null on the first one. It stays the same for the whole visit (so "新" marks
 * do not vanish while being read), and this visit is recorded for the next.
 * Scoped by the provider's `scopeKey`, so identities do not share it.
 */
export function useNotesSeen(rootLineId: string, { store = localNotesSeen, now = () => new Date().toISOString() }: NotesSeenOptions = {}): string | null {
  const { scopeKey } = useTangent();
  const [visit, setVisit] = useState(() => ({ rootLineId, seenAt: store.get(scopeKey, rootLineId) }));
  if (visit.rootLineId !== rootLineId) setVisit({ rootLineId, seenAt: store.get(scopeKey, rootLineId) });
  useEffect(() => {
    // Recorded once per visit (conversation), not on every render, so `now` is not a dependency.
    store.set(scopeKey, rootLineId, now());
  }, [store, scopeKey, rootLineId]);
  return visit.rootLineId === rootLineId ? visit.seenAt : store.get(scopeKey, rootLineId);
}
