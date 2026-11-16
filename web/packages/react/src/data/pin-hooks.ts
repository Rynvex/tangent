/**
 * Pinning a message (B9, core): always loaded with the message actions, so
 * kept apart from the lazily loaded P2 hooks. The result is written into the
 * cached transcript; `message.updated` does the same for other tabs.
 */
import type { MessagePage } from "@tangent/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTangent } from "../provider";
import { upsertMessage } from "./message-cache";

export interface PinInput {
  messageId: string;
  pinned: boolean;
}

/** Pins or unpins any message; call `mutateAsync` per press (one mutation serves every message, R7). */
export function usePinMessage() {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, pinned }: PinInput) => (pinned ? client.pinMessage(messageId) : client.unpinMessage(messageId)),
    onSuccess: ({ message }) => {
      queryClient.setQueryData<MessagePage>(keys.messages(message.lineId), (page) => (page ? upsertMessage(page, message) : page));
    },
  });
}
