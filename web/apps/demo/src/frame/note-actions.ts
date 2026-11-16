import { noteFromText, type Message, type MessageSelection } from "@tangent/client";
import { describeError, hasTextSelection, readMessageSelection, useCommand, useCreateNote, useTangent, useUiT } from "@tangent/react";
import type { RefObject } from "react";

export interface NoteActions {
  onNoteMessage: (message: Message) => void;
  onNoteSelection: (selection: MessageSelection) => void;
}

/**
 * "記進紀要" from a reply's actions, the selection toolbar and ⌘⇧N: the text
 * goes into 待確認 with the message as its source (as the prototype does),
 * and can be edited on the notes page. A selection inside a conclusion card
 * or move marker counts (the card is the source). ⌘⇧N saves the selection;
 * only with nothing selected does it save the last reply, and a selection it
 * cannot use (across messages, outside the thread) saves nothing and says
 * so (DESIGN §12 R5). Null when notes are off or nothing can be written.
 */
export function useNoteActions(lineId: string, enabled: boolean, container: RefObject<HTMLElement | null>, lastReply: Message | undefined, toast: (message: string) => void): NoteActions | null {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const create = useCreateNote(lineId);
  const save = (text: string, messageId: string) => {
    const note = noteFromText(text);
    if (!note) return;
    // Its own promise per save (R7 D1): two quick saves each get their toast, a failure included.
    create.mutateAsync({ section: "to_confirm", text: note, sourceMessageId: messageId }).then(
      () => toast(t("notes.savedTo", { section: t("notes.section.to_confirm") })),
      (error: unknown) => toast(t("notes.fromMessageFailed", { reason: describeError(error, t, hostErrorText) })),
    );
  };
  useCommand(
    "notes.add",
    () => {
      const selection = readMessageSelection(container.current);
      if (selection) save(selection.text, selection.messageId);
      else if (hasTextSelection()) toast(t("selection.oneMessage"));
      else if (lastReply) save(lastReply.content, lastReply.id);
    },
    enabled,
  );
  if (!enabled) return null;
  return { onNoteMessage: (message) => save(message.content, message.id), onNoteSelection: (selection) => save(selection.text, selection.messageId) };
}
