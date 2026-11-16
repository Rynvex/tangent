/**
 * Deleting a term waits before it is sent (F19 §2.2; the same promise as
 * F18's delayed deletes): the server has no undo, so 刪除 only hides the
 * term and the request goes out after `TERM_DELETE_UNDO_MS`; 復原 within
 * that time cancels it. The waits live in this module, not in the panel, so
 * switching the side panel's tab or closing it changes nothing; leaving the
 * page sends what is waiting at once. Each delete is sent exactly once, or
 * never (undone).
 */
import { classifyTermError, type TangentClient, type Term } from "@tangent/client";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { TangentKeys } from "../query-keys";
import { forgetTerm } from "../data/glossary-hooks";

export const TERM_DELETE_UNDO_MS = 5000;

/** What a waiting delete needs when its time comes (the screen that asked may be gone by then). */
export interface TermDeleteContext {
  client: TangentClient;
  queryClient: QueryClient;
  keys: TangentKeys;
  /** A refusal: the term is back in the list; say why. Not called when the term was already gone. */
  onRefused: (term: Term, error: unknown) => void;
}

interface Waiting {
  term: Term;
  context: TermDeleteContext;
  timer: ReturnType<typeof setTimeout>;
}

const waiting = new Map<string, Waiting>();
const listeners = new Set<() => void>();
let hidden: ReadonlySet<string> = new Set();
let listening = false;

function changed(): void {
  hidden = new Set(waiting.keys());
  for (const listener of listeners) listener();
}

function send(termId: string, leaving: boolean): void {
  const entry = waiting.get(termId);
  if (!entry) return;
  // Out of the map first: nothing can send it a second time.
  waiting.delete(termId);
  clearTimeout(entry.timer);
  const { term, context } = entry;
  const done = () => forgetTerm(context.queryClient, context.keys, term.rootLineId, term.id);
  context.client.deleteTerm(term.id, leaving ? { keepalive: true } : undefined).then(done, (error: unknown) => {
    // Deleted elsewhere meanwhile is what was asked for.
    if (classifyTermError(error).kind === "gone") return done();
    if (!leaving) context.onRefused(term, error);
  });
  changed();
}

const leave = () => {
  for (const termId of [...waiting.keys()]) send(termId, true);
};

/** Starts (or restarts) the wait for `term`; it is hidden until sent or undone. */
export function scheduleTermDelete(term: Term, context: TermDeleteContext, delayMs: number = TERM_DELETE_UNDO_MS): void {
  const before = waiting.get(term.id);
  if (before) clearTimeout(before.timer);
  waiting.set(term.id, { term, context, timer: setTimeout(() => send(term.id, false), delayMs) });
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("pagehide", leave);
  }
  changed();
}

/** The terms waiting to be deleted, oldest ask first. */
export function waitingTermDeletes(): Term[] {
  return [...waiting.values()].map((entry) => entry.term);
}

/** Gives every waiting delete the full time again (one 復原 then covers them all). */
export function restartTermDeletes(delayMs: number = TERM_DELETE_UNDO_MS): void {
  for (const entry of [...waiting.values()]) scheduleTermDelete(entry.term, entry.context, delayMs);
}

/** Takes back every delete still waiting (or only `termIds`); returns the terms that were. */
export function undoTermDeletes(termIds?: readonly string[]): Term[] {
  const ids = termIds ?? [...waiting.keys()];
  const undone: Term[] = [];
  for (const termId of ids) {
    const entry = waiting.get(termId);
    if (!entry) continue;
    clearTimeout(entry.timer);
    waiting.delete(termId);
    undone.push(entry.term);
  }
  if (undone.length > 0) changed();
  return undone;
}

/** Sends everything waiting now (tests, and a host that is going away). */
export function flushTermDeletes(): void {
  for (const termId of [...waiting.keys()]) send(termId, false);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => hidden;

/** The ids of the terms hidden while their delete waits. */
export function useHiddenTermIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
