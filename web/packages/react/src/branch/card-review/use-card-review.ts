/**
 * The state of the card review (A5, F10 §4.1): the card opens at once,
 * prefilled from the branch (or with its ready AI draft), the AI draft runs
 * only when asked for, then the user's edits, the note proposals, and
 * bringing the card back with the server's refusals sorted out. Server data
 * stays in the query cache; only the draft flow and the form live here.
 */
import {
  buildMergeBody,
  buildNoteChanges,
  classifyReturnError,
  featureMode,
  initialDraftFlow,
  isFeatureOn,
  messagesSince,
  problemsByField,
  prefillCard,
  proposalsFromDraft,
  validateCard,
  type BranchDetail,
  type CardAction,
  type MergeBranchResult,
  type Message,
  type NoteProposal,
  type ReturnFailure,
} from "@tangent/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMergeBranch, useStartDraft } from "../../data/branch-mutations";
import { useBranchDetail } from "../../data/branch-queries";
import { fetchAllMessages, useCapabilities, useMessages } from "../../data/queries";
import { useTangent } from "../../provider";
import { reviewFlowReducer } from "./review-flow";

export type BringBackMode = "all" | "ticked";

const allIncluded = (rows: readonly NoteProposal[]) => rows.map((row) => ({ ...row, included: true }));

function useFreshDetail(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.fetchQuery({ queryKey: keys.branch(lineId), queryFn: ({ signal }) => client.getBranch(lineId, { signal }), staleTime: 0 }), [client, keys, lineId, queryClient]);
}

/** The branch's messages for the prefill: the cached ones (kept live by events) or one read; none when that fails. */
function usePrefillMessages(lineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.ensureQueryData({ queryKey: keys.messages(lineId), queryFn: ({ signal }) => fetchAllMessages(client, lineId, signal) }).then((page) => page.messages, () => []),
    [client, keys, lineId, queryClient],
  );
}

export function useCardReview(lineId: string, onMerged: (result: MergeBranchResult) => void) {
  const capabilities = useCapabilities();
  const aiDraftOn = featureMode(capabilities.data, "card_draft") !== "off";
  const notesOn = isFeatureOn(capabilities.data, "notes");
  const [flow, dispatch] = useReducer(reviewFlowReducer, undefined, initialDraftFlow);
  const detail = useBranchDetail(lineId, { poll: flow.phase === "drafting" });
  const branchMessages = useMessages(lineId);
  const parentId = detail.data?.branch.parentLineId ?? null;
  const parentMessages = useMessages(parentId);
  const startDraft = useStartDraft(lineId);
  const merge = useMergeBranch(lineId);
  const fetchDetail = useFreshDetail(lineId);
  const fetchMessages = usePrefillMessages(lineId);
  const [tip, setTip] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<ReturnFailure | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string[]>>({});
  const [movedDismissed, setMovedDismissed] = useState(false);
  const [rows, setRows] = useState<NoteProposal[]>([]);
  /** Bumped whenever bringing back stopped on field problems (local or `invalid_card`): the form shows the first one. */
  const [fieldFailures, setFieldFailures] = useState(0);
  const lastMode = useRef<BringBackMode>("all");
  const draftingSince = useRef(0);
  const started = useRef(false);

  const begin = useCallback(async () => {
    draftingSince.current = Date.now();
    try {
      const job = await startDraft.mutateAsync();
      // B5: the job names the provider and model it will use (older servers do not; the detail does once read).
      dispatch({ type: "started", provider: job.provider ?? "", model: job.model ?? "" });
    } catch (error) {
      dispatch({ type: "startFailed", error });
    }
  }, [startDraft]);

  // On open: read the branch fresh, remember the parent's tip the user is shown, then show its ready
  // draft, or the card prefilled from the branch (F10 §4.1: no draft starts by itself; a running one is resumed).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void Promise.all([fetchDetail(), fetchMessages()]).then(
      ([fresh, messages]: [BranchDetail, Message[]]) => {
        setTip(fresh.parentTipMessageId);
        if (fresh.draft.status === "ready" && fresh.draft.card) {
          dispatch({ type: "serverDraft", draft: fresh.draft, now: Date.now() });
          return;
        }
        dispatch({ type: "prefill", card: prefillCard(fresh.branch.purpose, messages) });
        if (fresh.draft.status !== "drafting") return;
        draftingSince.current = Date.now();
        dispatch({ type: "started", provider: fresh.draft.provider, model: fresh.draft.model });
      },
      (error: unknown) => {
        setTip("");
        dispatch({ type: "startFailed", error });
      },
    );
  }, [fetchDetail, fetchMessages]);

  // While drafting, `branch.changed` (and the poll) refresh the detail; a newer read moves the flow on.
  useEffect(() => {
    if (flow.phase !== "drafting" || !detail.data || detail.dataUpdatedAt < draftingSince.current) return;
    dispatch({ type: "serverDraft", draft: detail.data.draft, now: Date.now() });
  }, [flow.phase, detail.data, detail.dataUpdatedAt]);

  // The draft's note proposals (B5) become rows once per draft; refetches of the same draft keep the user's edits.
  const draft = detail.data?.draft;
  const proposalsKey = flow.source === "ai" && draft?.status === "ready" ? `${draft.startedAt ?? ""}:${draft.uptoSeq}` : null;
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (!notesOn || proposalsKey === null || seeded.current === proposalsKey) return;
    seeded.current = proposalsKey;
    const proposed = proposalsFromDraft(draft?.noteChanges ?? []);
    setRows((current) => [...proposed, ...current.filter((row) => !row.ai)]);
  }, [notesOn, proposalsKey, draft]);

  const aiBusy = flow.phase === "drafting" || startDraft.isPending;
  const problems = useMemo(() => validateCard(flow.card), [flow.card]);
  const draftTip = flow.source === "ai" ? (detail.data?.draft.parentTipMessageId ?? "") : "";
  const movedSinceDraft = flow.phase === "review" && draftTip && tip && draftTip !== tip && !movedDismissed ? messagesSince(parentMessages.data?.messages ?? [], draftTip).length : 0;

  const submit = (mode: BringBackMode, confirmParentMoved = false) => {
    // One merge at a time (R7 D1 sweep): the per-call callbacks below belong to that call. Not while the AI drafts over the card.
    if (merge.isPending || aiBusy) return;
    setAttempted(true);
    setFailure(null);
    setServerErrors({});
    lastMode.current = mode;
    if (problems.length > 0) {
      setFieldFailures((count) => count + 1);
      return;
    }
    if (flow.phase !== "review" || tip === null) return;
    const notes = buildNoteChanges(mode === "all" ? allIncluded(rows) : rows);
    merge.mutate(buildMergeBody(flow.card, tip, confirmParentMoved, notesOn ? notes : []), {
      onSuccess: onMerged,
      onError: (error) => {
        const classified = classifyReturnError(error);
        setFailure(classified);
        if (classified.kind === "invalid_card") {
          setServerErrors(problemsByField(classified.problems));
          setFieldFailures((count) => count + 1);
        }
        if (classified.kind === "invalid_parent_tip") void fetchDetail().then((fresh) => setTip(fresh.parentTipMessageId), () => undefined);
      },
    });
  };

  // "Ask the AI" and "draft again": the draft runs over the card in review, which stays if it fails.
  const askAi = () => {
    if (startDraft.isPending || flow.phase !== "review") return;
    setFailure(null);
    setServerErrors({});
    setAttempted(false);
    setMovedDismissed(false);
    void fetchDetail().then((fresh) => setTip(fresh.parentTipMessageId), () => undefined);
    void begin();
  };

  return {
    flow,
    detail: detail.data ?? null,
    branchMessages: branchMessages.data?.messages ?? [],
    parentMessages: parentMessages.data?.messages ?? [],
    notesOn,
    aiDraftOn,
    /** The AI draft is being asked for or written: the form waits. */
    aiBusy,
    rows,
    setRows,
    problems,
    attempted,
    failure,
    serverErrors,
    fieldFailures,
    movedSinceDraft,
    pending: merge.isPending,
    edit: (action: CardAction) => dispatch({ type: "card", action }),
    abandon: () => dispatch({ type: "abandon" }),
    submit,
    bringBackAnyway: () => submit(lastMode.current, true),
    dismissMoved: () => setMovedDismissed(true),
    askAi,
  };
}

export type CardReviewState = ReturnType<typeof useCardReview>;
