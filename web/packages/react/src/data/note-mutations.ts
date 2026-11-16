/**
 * Note writes (A9). Editing text or status is optimistic (the change shows at
 * once and rolls back with the error); adding and replacing wait for the
 * server, which assigns ids and checks the limits, then write the result into
 * the cache. Every write invalidates the notes and the previews on settle:
 * the notes block is in every prompt of the tree.
 */
import type { Note, NotesView, NoteWriteResult, SupersedeNoteInput, UpdateNoteInput } from "@tangent/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";
import { invalidatePreviews, writeResult } from "./create-note";

export { useCreateNote } from "./create-note";

function useSettle(rootLineId: string) {
  const { keys } = useTangent();
  const queryClient = useQueryClient();
  return {
    queryClient,
    keys,
    apply: (result: NoteWriteResult) => queryClient.setQueryData<NotesView>(keys.notes(result.rootLineId), (view) => writeResult(view, result)),
    settle: () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.notes(rootLineId) }), invalidatePreviews(queryClient, keys)]),
  };
}

export interface UpdateNoteVariables {
  noteId: string;
  input: UpdateNoteInput;
}

/** Edits a note's text, section or status in place; optimistic, rolled back on failure. */
export function useUpdateNote(rootLineId: string) {
  const { client } = useTangent();
  const { queryClient, keys, apply, settle } = useSettle(rootLineId);
  return useMutation({
    mutationFn: ({ noteId, input }: UpdateNoteVariables) => client.updateNote(rootLineId, noteId, input),
    onMutate: async ({ noteId, input }: UpdateNoteVariables) => {
      const key = keys.notes(rootLineId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<NotesView>(key);
      const patch = (note: Note): Note => (note.id === noteId ? { ...note, ...input } : note);
      queryClient.setQueryData<NotesView>(key, (view) => (view ? { ...view, notes: view.notes.map(patch) } : view));
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(keys.notes(rootLineId), context.previous);
    },
    onSuccess: apply,
    onSettled: settle,
  });
}

export interface SupersedeNoteVariables {
  noteId: string;
  input: SupersedeNoteInput;
}

/** Replaces a note with a new one (the old one is kept, struck through, pointing to it). */
export function useSupersedeNote(rootLineId: string) {
  const { client } = useTangent();
  const { apply, settle } = useSettle(rootLineId);
  return useMutation({
    mutationFn: ({ noteId, input }: SupersedeNoteVariables) => client.supersedeNote(rootLineId, noteId, input),
    onSuccess: apply,
    onSettled: settle,
  });
}
