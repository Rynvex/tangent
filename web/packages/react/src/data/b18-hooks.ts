/**
 * B18 / F13: folders and tags, import, extract and the decompose plan; B18.1
 * the tenant's folder and tag counts (`useLineOrganization`); B20 / F15
 * attaching another conversation as a branch (`useAttachLine`). None
 * is optimistic (the server normalises folders and tags and checks every
 * limit); each writes what its result says and invalidates what it changed.
 */
import type { AttachLineInput, AttachLineResult, ExtractBranchInput, ExtractBranchResult, ImportConversationInput, LinePage, LineView, RenameFolderInput, UpdateLineInput } from "@tangent/client";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTangent, type TangentContextValue } from "../provider";

type Keys = TangentContextValue["keys"];

/** The lists and the tenant's folder and tag counts (B18.1) after a write that may change either. */
function invalidateOrganized(queryClient: QueryClient, keys: Keys): Promise<unknown> {
  return Promise.all([queryClient.invalidateQueries({ queryKey: keys.lineLists() }), queryClient.invalidateQueries({ queryKey: keys.lineOrganization() })]);
}

/** A main line written by a PATCH, an import or a rename: its view, and the lists (a filter or folder may now include or leave it out). */
function settleLine(queryClient: QueryClient, keys: Keys, line: LineView): Promise<unknown> {
  queryClient.setQueryData(keys.lineView(line.id), line);
  queryClient.setQueriesData<LinePage>({ queryKey: keys.lineLists() }, (page) => (page ? { ...page, lines: page.lines.map((item) => (item.id === line.id ? line : item)) } : page));
  return invalidateOrganized(queryClient, keys);
}

/**
 * The tenant's folders (active and archived apart) and tags with counts over every main line (B18.1), for the list's
 * chips and folders and the folder and tag pickers; a viewer may read it. Writes and `line.*` events invalidate it.
 */
export function useLineOrganization(enabled = true) {
  const { client, keys } = useTangent();
  return useQuery({ queryKey: keys.lineOrganization(), queryFn: ({ signal }) => client.getLineOrganization({ signal }), enabled });
}

/** A main line's folder and tags (`tags` replaces the whole set); the field left out stays. */
export function useUpdateLineOrganization() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, ...input }: { lineId: string } & Pick<UpdateLineInput, "folder" | "tags">) => client.updateLine(lineId, input),
    onSuccess: (line) => settleLine(queryClient, keys, line),
  });
}

/** Every main line in `from` moves to `to` (`""` dissolves the folder); `line.updated` brings each line, the lists reload. */
export function useRenameFolder() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RenameFolderInput) => client.renameFolder(input),
    onSuccess: () => invalidateOrganized(queryClient, keys),
  });
}

/** Imports a parsed conversation (no model is called); the new conversation joins the lists. */
export function useImportConversation() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ImportConversationInput) => client.importConversation(input),
    onSuccess: (result) => {
      queryClient.setQueryData(keys.lineView(result.line.id), result.line);
      return invalidateOrganized(queryClient, keys);
    },
  });
}

/**
 * What an extract changed, reloaded from scratch: the marker (or card) took
 * the range's old seq, older than anything an `afterSeq` cursor would fetch,
 * so the source's and the new branch's messages are reset (not merged) and
 * refetched, with the tree's outline, chapters and folds and both lines.
 */
export function resetAfterExtract(queryClient: QueryClient, keys: Keys, result: ExtractBranchResult): Promise<unknown> {
  const lines = [result.sourceLineId, result.branch.lineId];
  const reset = lines.flatMap((lineId) => [keys.messages(lineId), keys.folds(lineId), keys.stream(lineId)]);
  const invalidate = [keys.branchesOf(result.rootLineId), keys.chaptersOf(result.rootLineId), keys.branch(result.branch.lineId), ...lines.map((lineId) => keys.lineView(lineId)), ...result.reparented.map((lineId) => keys.lineView(lineId))];
  queryClient.setQueryData(keys.lineView(result.line.id), result.line);
  return Promise.all([
    ...reset.map((queryKey) => queryClient.resetQueries({ queryKey })),
    ...invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    queryClient.invalidateQueries({ queryKey: [...keys.line(result.sourceLineId), "preview"] }),
  ]);
}

/** Extracts `[from … to]` of `lineId` into a branch (marker, or with `card` a delivered card, in its place). */
export function useExtractBranch(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ExtractBranchInput) => client.extractBranch(lineId, input),
    // Not awaited: the caller's own success (closing its dialog) comes first, then the lines reload.
    onSuccess: (result) => void resetAfterExtract(queryClient, keys, result),
  });
}

/**
 * The decompose plan of a line (writes nothing; a viewer may read it). It is
 * a snapshot for one opening of the panel: applying a card must not make the
 * plan change under the user, so it never refetches on its own and is
 * dropped as soon as nothing shows it.
 */
export function useDecompose(lineId: string | null) {
  const { client, keys } = useTangent();
  return useQuery({
    queryKey: keys.decompose(lineId ?? ""),
    queryFn: ({ signal }) => client.decomposeLine(lineId ?? "", { signal }),
    enabled: lineId !== null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * What an attach changed (B20): the source is a branch line now, so it leaves every cached list; the target tree's outline,
 * chapters, notes, memos, seeds and the target's messages (a card may be on it) reload, with the lines involved and the
 * tenant's folder counts. The decompose plan is a snapshot of one opening (it shows the attach as applied) and is left alone.
 */
export function settleAfterAttach(queryClient: QueryClient, keys: Keys, result: AttachLineResult): Promise<unknown> {
  const root = result.branch.rootLineId || result.targetLine.id;
  queryClient.setQueryData(keys.lineView(result.targetLine.id), result.targetLine);
  queryClient.setQueryData(keys.lineView(result.branchLine.id), result.branchLine);
  queryClient.setQueriesData<LinePage>({ queryKey: keys.lineLists() }, (page) => (page ? { ...page, lines: page.lines.filter((item) => item.id !== result.branchLine.id) } : page));
  const invalidate = [
    // What was cached under the source as a main line (its outline, chapters, notes, links) is the target tree's now.
    keys.line(result.branchLine.id),
    keys.branchesOf(root),
    keys.chaptersOf(root),
    keys.notes(root),
    keys.memos(root),
    keys.seedsOf(root),
    keys.suggestionsOf(root),
    keys.groupsOf(root),
    keys.lineView(root),
    keys.messages(result.targetLine.id),
    keys.branch(result.branchLine.id),
    ...result.reparented.map((lineId) => keys.lineView(lineId)),
    keys.lineLists(),
    keys.lineOrganization(),
  ];
  return Promise.all(invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** Attaches another main line (with its tree) under `targetLineId` as a branch; with `status: "merged"` its card stays on the line. */
export function useAttachLine(targetLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AttachLineInput) => client.attachLine(targetLineId, input),
    // Not awaited: the caller's own success (its applied state, closing its dialog) comes first, then the tree reloads.
    onSuccess: (result) => void settleAfterAttach(queryClient, keys, result),
  });
}
