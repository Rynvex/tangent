import type { BranchView, Suggestion } from "@tangent/client";
import { useState, type ReactNode } from "react";
import { GroupFormDialog, type GroupFormMode } from "./group-form-dialog";

export interface GroupFormRequest {
  mode: GroupFormMode;
  members: readonly BranchView[];
  /** An AI group suggestion being reviewed. */
  suggestion?: Suggestion;
}

/**
 * Opens the C2 group / combine dialog for a selection or a suggestion;
 * render `dialog` once in the host. A form opened in one conversation is
 * dropped when the host moves to another (R9 G1).
 */
export function useGroupForm(rootLineId: string, onDone?: (result: { groupId?: string; lineId?: string }) => void): { open: (request: GroupFormRequest) => void; dialog: ReactNode } {
  const [opened, setRequest] = useState<{ id: number; rootLineId: string; request: GroupFormRequest } | null>(null);
  const open = (next: GroupFormRequest) => setRequest((current) => ({ id: (current?.id ?? 0) + 1, rootLineId, request: next }));
  const request = opened?.rootLineId === rootLineId ? opened : null;
  const dialog = request ? (
    <GroupFormDialog
      key={request.id}
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) setRequest(null);
      }}
      rootLineId={rootLineId}
      mode={request.request.mode}
      members={request.request.members}
      {...(request.request.suggestion ? { suggestion: request.request.suggestion } : {})}
      {...(onDone ? { onDone } : {})}
    />
  ) : null;
  return { open, dialog };
}
