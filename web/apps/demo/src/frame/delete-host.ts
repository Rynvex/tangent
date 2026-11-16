/**
 * Deleting a conversation from the frame (F7): which conversation the
 * confirmation dialog is about, and what happens once a tree is gone — here
 * (the dialog's result, or its `line.deleted` arriving first), elsewhere
 * (another tab's or device's `line.deleted`), or found missing (a read of the
 * line on screen answers `line_not_found`, e.g. after a reconnect missed the
 * event). If the conversation on screen went, the frame leaves it for the
 * next one; each tree is handled once, whichever of those comes first.
 * B23 / F18: `line.deleted` also says that only some lines of a tree went (a
 * deleted branch, a cleared or continued aside; the main line stays). Then
 * the frame stays in the conversation, on the nearest line above that is
 * left, unless this page is itself replacing the line (`expectedGone`).
 */
import { hasErrorCode, type DeleteLineResult, type LineView, type TangentEvent } from "@tangent/client";
import { describeError, useDeleteLine, useTangent, useUiT } from "@tangent/react";
import { useEffect, useRef, useState } from "react";
import type { DeleteConversationDialogProps } from "./delete-conversation";
import { expectedGone } from "./expected-gone";

export interface ConversationDeletionOptions {
  /** The line on screen and its tree's main line. */
  selected: string | null;
  rootId: string | null;
  /** The error of the on-screen line's read. */
  lineError: unknown;
  /**
   * Leave the line on screen; `gone` are the deleted lines. The frame shows the next conversation when the whole tree
   * went, and the nearest line above that is left when only branches did.
   */
  leave: (gone: ReadonlySet<string>) => void;
  toast: (message: string) => void;
  /**
   * Ask before deleting (the default). Off (G2, Settings → General → Delete confirmation), 刪除對話… deletes at once;
   * a refusal (a reply still running) is said and the dialog opens, so the choice can be made again there.
   */
  confirm?: boolean;
}

export interface ConversationDeletion {
  /** 刪除對話… from a menu: ask first. */
  request: (line: LineView) => void;
  /** For `useTangentEvents({ onEvent })`. */
  onEvent: (event: TangentEvent) => void;
  /** F18: this page deleted (or is about to hide) these branch lines; the frame leaves one that is on screen, quietly. */
  linesGone: (lineIds: readonly string[]) => void;
  /** The dialog's props once one was asked for (it stays mounted after, for its exit and focus return). */
  dialog: DeleteConversationDialogProps | null;
}

/**
 * Where focus lands after a delete: the conversation now current in the list,
 * else the composer, else the list's first button (新對話 when none is left),
 * else the header (the embedded frame has no list).
 */
function focusAfterDelete(): HTMLElement | null {
  const first = (selector: string) => document.querySelector<HTMLElement>(selector);
  return first('nav [aria-current="page"]') ?? first("main textarea") ?? first("nav button") ?? first("main header button");
}

/**
 * The conversation to show after `rootId`'s tree went: the one after it in
 * the list (by activity), else the one before, else the list's first that is
 * left (an archived one was on screen); null when none is left. Named
 * explicitly, so the screen does not follow whichever conversation is newest.
 */
export function nextConversation(lines: readonly LineView[], gone: ReadonlySet<string>, rootId: string | null): string | null {
  const at = rootId ? lines.findIndex((line) => line.id === rootId) : -1;
  const left = (from: readonly LineView[]) => from.find((line) => !gone.has(line.id))?.id ?? null;
  if (at < 0) return left(lines);
  return left(lines.slice(at + 1)) ?? left([...lines.slice(0, at)].reverse());
}

export function useConversationDeletion({ selected, rootId, lineError, leave, toast, confirm = true }: ConversationDeletionOptions): ConversationDeletion {
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const remove = useDeleteLine();
  const [target, setTarget] = useState<LineView | null>(null);
  const [open, setOpen] = useState(false);
  /** Trees this page already handled (ids are never reused). */
  const handled = useRef(new Set<string>());
  /** The last close was a delete: the trigger may be gone, so focus moves on. */
  const deleted = useRef(false);

  /** A tree is gone; `here` when this page deleted it (the toast names it). */
  const gone = (rootLineId: string, lineIds: readonly string[], here: LineView | null) => {
    if (handled.current.has(rootLineId)) return;
    handled.current.add(rootLineId);
    const ids = new Set([rootLineId, ...lineIds]);
    const onScreen = [selected, rootId].some((id) => id !== null && ids.has(id));
    if (onScreen) leave(ids);
    if (here) toast(t("shell.deleted", { title: here.title || t("shell.untitled") }));
    else if (onScreen) toast(t("shell.deletedElsewhere"));
  };

  const closeDeleted = () => {
    deleted.current = true;
    setOpen(false);
  };

  /** Some lines of a tree went and one of them is on screen (B23): leave it, and say so when it was not asked for here. */
  const linesGone = (lineIds: readonly string[], here: boolean) => {
    if (selected === null || !lineIds.includes(selected) || expectedGone.has(selected)) return;
    leave(new Set(lineIds));
    if (!here) toast(t("shell.branchGoneElsewhere"));
  };

  // A line this page is replacing (接著問) is expected to go: the flow that asked moves on.
  const missing = selected !== null && !expectedGone.has(selected) && hasErrorCode(lineError, "line_not_found");
  useEffect(() => {
    // Keyed by the line itself: the remembered root may still be the previous tree's while this line never loaded.
    if (missing && selected) gone(selected, [selected], null);
    // `gone` is rebuilt every render; the read's failure is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, selected]);

  const onEvent = (event: TangentEvent) => {
    if (event.type !== "line.deleted") return;
    const { rootLineId, lineIds } = event.data;
    // The tree stays: only these lines went.
    if (lineIds[0] !== rootLineId) return linesGone(lineIds, false);
    // Our own delete's event may come before its result: the dialog about this tree means it is ours.
    const ours = open && target?.id === rootLineId ? target : null;
    if (ours) closeDeleted();
    gone(rootLineId, lineIds, ours);
  };

  const onDeleted = (result: DeleteLineResult, line: LineView) => {
    closeDeleted();
    gone(result.rootLineId, result.lineIds, line);
  };

  const ask = (line: LineView) => {
    deleted.current = false;
    setTarget(line);
    setOpen(true);
  };

  /** Without the confirmation: delete now; a failure is said and falls back to the dialog. */
  const deleteNow = (line: LineView) =>
    remove.mutate(line.id, {
      onSuccess: (result) => gone(result.rootLineId, result.lineIds, line),
      onError: (error) => {
        toast(describeError(error, t, hostErrorText));
        ask(line);
      },
    });

  return {
    request: (line) => (confirm ? ask(line) : deleteNow(line)),
    onEvent,
    linesGone: (lineIds) => linesGone(lineIds, true),
    dialog: target && {
      open,
      line: target,
      onOpenChange: setOpen,
      onDeleted,
      finalFocus: () => (deleted.current ? (focusAfterDelete() ?? true) : true),
    },
  };
}
