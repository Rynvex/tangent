/**
 * Adding a note on its own (F20a): the conversation's 存成紀要 uses it from the
 * main bundle, the edits (`note-mutations.ts`, which re-exports this) load with
 * the notes tab. Holds the cache helpers both share.
 */
import type { CreateNoteInput, NotesView, NoteWriteResult } from "@tangent/client";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTangent, type TangentContextValue } from "../provider";

/**
 * Puts a write's notes into the cached page without reordering it: a note
 * already there (edited, or the one a replacement superseded) is swapped in
 * place, so the list does not jump before the refetch; a new note goes first.
 */
export function writeResult(view: NotesView | undefined, result: NoteWriteResult): NotesView | undefined {
  if (!view) return view;
  const changed = new Map([result.note, ...(result.superseded ? [result.superseded] : [])].map((note) => [note.id, note]));
  const cached = new Set(view.notes.map((note) => note.id));
  const added = [...changed.values()].filter((note) => !cached.has(note.id));
  const notes = view.notes.map((note) => changed.get(note.id) ?? note);
  return { ...view, revision: Math.max(view.revision, result.revision), notes: [...added, ...notes] };
}

/** Every cached `POST /preview` (any line of any tree): the notes block may have changed. */
export function invalidatePreviews(queryClient: QueryClient, keys: TangentContextValue["keys"]): Promise<void> {
  const prefix = keys.all;
  return queryClient.invalidateQueries({
    predicate: (query) => prefix.every((part, index) => query.queryKey[index] === part) && query.queryKey.at(-2) === "preview",
  });
}

/** Adds one note to the tree of `lineId` (any line of the tree; the server files it under the root). */
export function useCreateNote(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNoteInput) => ctx.client.createNote(lineId, input),
    onSuccess: (result) => {
      queryClient.setQueryData<NotesView>(ctx.keys.notes(result.rootLineId), (view) => writeResult(view, result));
      return Promise.all([queryClient.invalidateQueries({ queryKey: ctx.keys.notes(result.rootLineId) }), invalidatePreviews(queryClient, ctx.keys)]);
    },
  });
}
