/**
 * Write hooks (F1). Sending is optimistic: the user's message shows at once,
 * is swapped for the server's copy on success (by the ids the 202 returns)
 * and removed on failure (the composer keeps the text); the messages are
 * read again once the request settles. A 403 `forbidden` on a send or turn
 * action turns the provider read-only (unless /capabilities says otherwise).
 */
import { hasErrorCode, type CreateLineInput, type LineView, type MessagePage, type SendMessageResult, type UpdateLineInput } from "@tangent/client";
import { notifyManager, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTangent, type TangentContextValue } from "../provider";
import { lastSeq, optimisticUserMessage, removeMessage, upsertMessage } from "./message-cache";
import { forgetTree } from "./tree-cache";

/** Marks the provider read-only when the server refused a send or turn action. */
function noteForbidden(ctx: TangentContextValue, error: unknown): void {
  if (hasErrorCode(error, "forbidden")) ctx.live.markForbidden();
}

/** Writes a 202 turn result into a cached page; a result never moves a finished reply back to pending. */
function addTurn(queryClient: QueryClient, ctx: TangentContextValue, lineId: string, result: SendMessageResult, optimisticId?: string): void {
  queryClient.setQueryData<MessagePage>(ctx.keys.messages(lineId), (page) => {
    if (!page) return page;
    const base = optimisticId ? removeMessage(page, optimisticId) : page;
    return upsertMessage(upsertMessage(base, result.userMessage), result.pendingMessage);
  });
}

function settleTurn(queryClient: QueryClient, ctx: TangentContextValue, lineId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ctx.keys.messages(lineId), exact: true }),
    queryClient.invalidateQueries({ queryKey: ctx.keys.lineView(lineId), exact: true }),
  ]);
}

export function useSendMessage(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  const key = ctx.keys.messages(lineId);
  return useMutation({
    mutationFn: (content: string) => ctx.client.sendMessage(lineId, { content }),
    onMutate: async (content: string) => {
      await queryClient.cancelQueries({ queryKey: key });
      const optimistic = optimisticUserMessage(lineId, content, lastSeq(queryClient.getQueryData<MessagePage>(key)));
      queryClient.setQueryData<MessagePage>(key, (page) => (page ? upsertMessage(page, optimistic) : page));
      return { optimisticId: optimistic.id };
    },
    onSuccess: (result, _content, context) => addTurn(queryClient, ctx, lineId, result, context.optimisticId),
    onError: (error, _content, context) => {
      noteForbidden(ctx, error);
      if (context) queryClient.setQueryData<MessagePage>(key, (page) => (page ? removeMessage(page, context.optimisticId) : page));
    },
    onSettled: () => settleTurn(queryClient, ctx, lineId),
  });
}

/** Runs the line's last, failed turn again (B4.1 `POST /retry`): a new pending reply, the failed one stays. */
export function useRetryTurn(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ctx.client.retryTurn(lineId),
    onSuccess: (result) => addTurn(queryClient, ctx, lineId, result),
    onError: (error) => noteForbidden(ctx, error),
    onSettled: () => settleTurn(queryClient, ctx, lineId),
  });
}

/** Stops the running reply; the stopped message (with what streamed) and the line come back in the result. */
export function useCancelTurn(lineId: string) {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => ctx.client.cancelTurn(lineId),
    onSuccess: (result) => {
      queryClient.setQueryData<LineView>(ctx.keys.lineView(lineId), result.line);
      const stopped = result.message;
      if (!stopped) return;
      queryClient.setQueryData<MessagePage>(ctx.keys.messages(lineId), (page) => (page ? upsertMessage(page, stopped) : page));
      // With the query update's notifications, so the stopped reply never renders without its text.
      notifyManager.schedule(() => ctx.live.finishTurn(lineId, stopped.id));
    },
    onError: (error) => noteForbidden(ctx, error),
    onSettled: () => settleTurn(queryClient, ctx, lineId),
  });
}

export function useCreateLine() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLineInput) => ctx.client.createLine(input),
    onSuccess: (line) => {
      queryClient.setQueryData(ctx.keys.lineView(line.id), line);
      void queryClient.invalidateQueries({ queryKey: ctx.keys.lineLists() });
      // B18.1: a folder or tags may have come or gone.
      void queryClient.invalidateQueries({ queryKey: ctx.keys.lineOrganization() });
    },
  });
}

export function useUpdateLine() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, input }: { lineId: string; input: UpdateLineInput }) => ctx.client.updateLine(lineId, input),
    onSuccess: (line) => {
      queryClient.setQueryData(ctx.keys.lineView(line.id), line);
      void queryClient.invalidateQueries({ queryKey: ctx.keys.lineLists() });
      // B18.1: a folder or tags may have come or gone.
      void queryClient.invalidateQueries({ queryKey: ctx.keys.lineOrganization() });
    },
  });
}

/** Archives (or restores) a whole conversation; both lists reload. */
export function useArchiveLine() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, archived }: { lineId: string; archived: boolean }) => (archived ? ctx.client.archiveLine(lineId) : ctx.client.unarchiveLine(lineId)),
    onSuccess: (result) => {
      for (const line of result.lines) {
        if (queryClient.getQueryData(ctx.keys.lineView(line.id)) !== undefined) queryClient.setQueryData(ctx.keys.lineView(line.id), line);
      }
      void queryClient.invalidateQueries({ queryKey: ctx.keys.lineLists() });
      // B18.1: archived lines count apart, and their tags not at all.
      void queryClient.invalidateQueries({ queryKey: ctx.keys.lineOrganization() });
    },
  });
}

/**
 * Deletes a whole conversation (`DELETE /lines/{id}`, main line only; F7):
 * every line of the tree leaves the cache and the lists, as on `line.deleted`
 * (whichever comes first does it). A screen showing the conversation should
 * leave it in the same update (the mutate call's `onSuccess`), or its queries
 * read the deleted lines again.
 */
export function useDeleteLine() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => ctx.client.deleteLine(lineId),
    onSuccess: (result) => forgetTree({ queryClient, keys: ctx.keys, live: ctx.live }, result.lineIds),
  });
}

/** Clears a line's unread count. */
export function useMarkRead() {
  const ctx = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: string) => ctx.client.markRead(lineId),
    onSuccess: (line) => {
      if (queryClient.getQueryData(ctx.keys.lineView(line.id)) !== undefined) queryClient.setQueryData(ctx.keys.lineView(line.id), line);
    },
  });
}

/** `POST /compact`: summarise the line now (the summary job; `line.updated` brings the result). */
export function useCompact(lineId: string) {
  const { client } = useTangent();
  return useMutation({ mutationFn: () => client.compact(lineId) });
}
