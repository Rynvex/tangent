import type { CreateBranchInput, CreateBranchResult } from "@tangent/client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCreateBranch } from "../data/create-branch";
import { useTangent } from "../provider";

/** Where a branch-and-send stopped: the branch could not be opened, or it opened and the message was not sent. */
export type BranchSendFailure = { stage: "branch"; error: unknown } | { stage: "send"; error: unknown; created: CreateBranchResult };

/** Sends a new branch's first message; every key of that line (its view, messages, stream) reads the turn again either way, events keep it current from there. */
export function useSendFirst() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return async (lineId: string, text: string): Promise<void> => {
    try {
      await client.sendMessage(lineId, { content: text });
    } finally {
      void queryClient.invalidateQueries({ queryKey: keys.line(lineId) });
    }
  };
}

/**
 * Opens a branch and sends the first message in it (修改並分岔, 分岔重答):
 * two writes, the second only after the first. A failed send leaves the
 * branch (it is real now), so the caller can still go there.
 */
export function useBranchAndSend(parentLineId: string) {
  const create = useCreateBranch(parentLineId);
  const sendFirst = useSendFirst();
  const [pending, setPending] = useState(false);
  const run = async (input: CreateBranchInput, text: string): Promise<{ created: CreateBranchResult } | { failure: BranchSendFailure }> => {
    setPending(true);
    try {
      let created: CreateBranchResult;
      try {
        created = await create.mutateAsync(input);
      } catch (error) {
        return { failure: { stage: "branch", error } };
      }
      try {
        await sendFirst(created.line.id, text);
      } catch (error) {
        return { failure: { stage: "send", error, created } };
      }
      return { created };
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
}
