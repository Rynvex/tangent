/**
 * The frame's F8 parts that load on first use (6_FRONTEND_F8.md): the
 * in-tree search bar in its place under the header, and the export and
 * shortcut dialogs. `f8-frame.tsx` keeps only their state in the main bundle.
 */
import type { BranchView } from "@tangent/client";
import { InTreeSearchBar } from "@tangent/react";
import { ExportDialog } from "./export-dialog";
import { ShortcutsDialog } from "./shortcuts-dialog";

export interface SearchSlotProps {
  rootLineId: string;
  rootTitle: string;
  narrow: boolean;
  navigate: (lineId: string, messageId?: string) => void;
  /** The message jumped to (its fold opens while the bar is open). */
  onJumped: (messageId: string | null) => void;
  onFocusWithin: (inside: boolean) => void;
  onClose: () => void;
  /** Changes when the bar is asked for again: its box takes focus. */
  focusToken: number;
}

export function SearchSlot({ rootLineId, rootTitle, narrow, navigate, onJumped, onFocusWithin, onClose, focusToken }: SearchSlotProps) {
  return (
    <InTreeSearchBar
      rootLineId={rootLineId}
      rootTitle={rootTitle}
      narrow={narrow}
      onJump={(lineId, messageId) => {
        onJumped(messageId ?? null);
        navigate(lineId, messageId);
      }}
      onClose={onClose}
      onFocusWithin={onFocusWithin}
      focusToken={focusToken}
    />
  );
}

export interface DialogSlotProps {
  which: "shortcuts" | "export";
  onClose: () => void;
  rootLineId: string;
  lineId: string;
  title: string;
  outline: readonly BranchView[];
}

export function DialogSlot({ which, onClose, rootLineId, lineId, title, outline }: DialogSlotProps) {
  const onOpenChange = (open: boolean) => !open && onClose();
  if (which === "shortcuts") return <ShortcutsDialog open onOpenChange={onOpenChange} />;
  return <ExportDialog key={rootLineId} open onOpenChange={onOpenChange} rootLineId={rootLineId} lineId={lineId} title={title} outline={outline} />;
}
