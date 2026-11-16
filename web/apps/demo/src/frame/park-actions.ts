import { SEED_TEXT_MAX, charCount, seedFromText, type Message, type MessageSelection } from "@tangent/client";
import { describeError, useCommand, useCreateSeed, useTangent, useUiT } from "@tangent/react";
import { useRef } from "react";

export interface ParkActions {
  /** The composer's 停車 button and ⌘⇧S: park the draft and empty the composer. */
  onParkComposer: () => void;
  /** A message's 停車 action: its start, with the message as the seed's source. */
  onParkMessage: (message: Message) => void;
  /** The selection toolbar's 停車: the selected text, with its message as the source. */
  onParkSelection: (selection: MessageSelection) => void;
  /** An aside's 停車 (its answer). */
  onParkText: (text: string, anchorMessageId: string) => void;
}

/**
 * 停車 (B3): one press keeps a thought for later, costing no tokens. The
 * composer's text is parked whole (at most 500 characters; longer text is
 * kept and refused) and the composer empties only once the server has it; a
 * message or selection parks its start with the message as the source.
 * Null while parking is off or nothing can be written (then ⌘⇧S does nothing).
 */
export function useParkActions(
  lineId: string,
  enabled: boolean,
  draft: string,
  setDraft: (value: string) => void,
  toast: (message: string) => void,
  { shortcut = true }: { shortcut?: boolean } = {},
): ParkActions | null {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const create = useCreateSeed(lineId);
  /** The composer's text is on its way (R7 D3): a second press waits for it instead of parking it twice. */
  const composerBusy = useRef(false);
  // Each park awaits its own promise (R7 D1): a shared mutation's per-call callbacks only fire for its latest call.
  const park = async (text: string, anchorMessageId?: string): Promise<boolean> => {
    try {
      await create.mutateAsync({ text, ...(anchorMessageId ? { anchorMessageId } : {}) });
      toast(t("parking.parked"));
      return true;
    } catch (error) {
      toast(t("parking.failed", { reason: describeError(error, t, hostErrorText) }));
      return false;
    }
  };
  const parkComposer = () => {
    if (composerBusy.current) return;
    const text = draft.trim();
    if (text === "") return toast(t("parking.emptyComposer"));
    if (charCount(text) > SEED_TEXT_MAX) return toast(t("parking.tooLong", { limit: SEED_TEXT_MAX }));
    composerBusy.current = true;
    // The text stays in the composer until the server has it (a refusal keeps it to retry).
    void park(text)
      .then((parked) => parked && setDraft(""))
      .finally(() => {
        composerBusy.current = false;
      });
  };
  // Only the composer's owner listens for ⌘⇧S (one handler per command).
  useCommand("composer.park", parkComposer, enabled && shortcut);
  if (!enabled) return null;
  return {
    onParkComposer: parkComposer,
    onParkMessage: (message) => void park(seedFromText(message.content), message.id),
    onParkSelection: (selection) => void park(seedFromText(selection.text, SEED_TEXT_MAX), selection.messageId),
    onParkText: (text, anchorMessageId) => void park(seedFromText(text), anchorMessageId),
  };
}
