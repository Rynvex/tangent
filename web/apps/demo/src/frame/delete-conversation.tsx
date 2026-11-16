import { hasErrorCode, type DeleteLineResult, type LineView } from "@tangent/client";
import {
  Button,
  describeError,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorAlert,
  useArchiveLine,
  useBranches,
  useDeleteLine,
  useTangent,
  useUiT,
  type DialogContentProps,
} from "@tangent/react";
import { Archive, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useDeleteT } from "./delete-messages";

export interface DeleteConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A main line (only a whole conversation can be deleted). */
  line: LineView;
  /** The tree is gone; the caller leaves it if it is on screen. */
  onDeleted: (result: DeleteLineResult, line: LineView) => void;
  /** 改為封存 went through instead. */
  onArchived?: (line: LineView) => void;
  /** Where focus goes on close (the trigger may have gone with the conversation). */
  finalFocus?: DialogContentProps["finalFocus"];
}

/**
 * What goes: the tree's branch count (asides included) once the outline is
 * known. Read only while the dialog is open: once the tree is deleted (here
 * or elsewhere) the dialog closes in the same update, and its exit keeps the
 * count it had instead of asking for a tree that is gone.
 */
function TreeText({ rootLineId, open }: { rootLineId: string; open: boolean }) {
  const d = useDeleteT();
  const branches = useBranches(open ? rootLineId : null, true);
  const shown = useRef<number | undefined>(undefined);
  if (branches.data) shown.current = branches.data.branches.length;
  const count = shown.current;
  if (count === undefined) return <>{d("delete.treeUnknown")}</>;
  return <>{count === 0 ? d("delete.treeNone") : d("delete.tree", { count })}</>;
}

function DeleteBody({ open, line, onOpenChange, onDeleted, onArchived, finalFocus }: DeleteConversationDialogProps) {
  const d = useDeleteT();
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const remove = useDeleteLine();
  const archive = useArchiveLine();
  const cancel = useRef<HTMLButtonElement>(null);
  const archived = Boolean(line.archivedAt);
  const busy = remove.isPending || archive.isPending;
  const title = line.title || t("shell.untitled");
  const confirm = () => {
    if (busy) return;
    archive.reset();
    remove.mutate(line.id, { onSuccess: (result) => onDeleted(result, line) });
  };
  const archiveInstead = () => {
    if (busy) return;
    remove.reset();
    archive.mutate(
      { lineId: line.id, archived: true },
      {
        onSuccess: () => {
          onOpenChange(false);
          onArchived?.(line);
        },
      },
    );
  };
  const error = remove.error
    ? hasErrorCode(remove.error, "session_busy")
      ? d("delete.busy")
      : d("delete.failed", { reason: describeError(remove.error, t, hostErrorText) })
    : archive.error
      ? d("delete.archiveFailed", { reason: describeError(archive.error, t, hostErrorText) })
      : null;
  return (
    <DialogContent
      width="sm"
      title={d("delete.title", { title })}
      description={d("delete.permanent")}
      initialFocus={cancel}
      {...(finalFocus === undefined ? {} : { finalFocus })}
      footer={
        <>
          <DialogClose render={<Button ref={cancel}>{d("delete.cancel")}</Button>} />
          {!archived && (
            <Button icon={<Archive aria-hidden className="size-3.5" />} loading={archive.isPending} onClick={archiveInstead}>
              {d("delete.archiveInstead")}
            </Button>
          )}
          <Button variant="destructive" icon={<Trash2 aria-hidden className="size-3.5" />} loading={remove.isPending} loadingText={d("delete.deleting")} onClick={confirm}>
            {d("delete.confirm")}
          </Button>
        </>
      }
    >
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-tg-sm text-tg-foreground">
        <li>
          <TreeText rootLineId={line.id} open={open} />
        </li>
        <li>{archived ? d("delete.archivedHint") : d("delete.archiveHint")}</li>
      </ul>
      {error && (
        <ErrorAlert>
          <span>{error}</span>
        </ErrorAlert>
      )}
    </DialogContent>
  );
}

/**
 * 刪除對話 (F7): the whole tree, never undone, so the dialog says what goes
 * (with the branch count), offers 改為封存, starts on 取消 and closes on Esc;
 * 刪除對話 is the destructive button. A refusal (a reply still running:
 * `session_busy`) stays in the dialog.
 */
export function DeleteConversationDialog({ open, onOpenChange, line, ...rest }: DeleteConversationDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => onOpenChange(next)}>
      {/* Keyed by the conversation: a refusal for one never shows on the next. */}
      <DeleteBody key={line.id} open={open} line={line} onOpenChange={onOpenChange} {...rest} />
    </Dialog>
  );
}
