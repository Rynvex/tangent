import { branchDescendants, branchTitle, busyBranchUnder, classifyDeleteBranchError, type BranchView, type DeleteBranchFailure } from "@tangent/client";
import { Button, describeError, Dialog, DialogClose, DialogContent, ErrorAlert, forgetLines, useDeleteBranch, useTangent, useUiT } from "@tangent/react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAsideT } from "./aside-messages";
import type { ToastAction } from "./hooks";
import { createPendingDeletes, DELETE_UNDO_MS, type PendingDelete, type PendingDeletes } from "./pending-deletes";

/** One 刪除支線 / 丟掉 asked for; `n` makes each ask its own (the same branch may be asked for again after an undo). */
export interface BranchDeleteRequest {
  lineId: string;
  n: number;
}

export interface BranchDeleteHostProps {
  request: BranchDeleteRequest | null;
  /** The tree on screen and its outline with asides, as the frame reads it (branches waiting to be deleted are not in it). */
  rootId: string | null;
  outline: readonly BranchView[];
  /** Lines are gone, or about to be hidden: the frame leaves them if one is on screen (for the nearest line above). */
  onGone: (lineIds: readonly string[]) => void;
  navigate: (lineId: string) => void;
  toast: (message: string, action?: ToastAction, durationMs?: number) => void;
}

interface Confirming {
  branch: BranchView;
  under: readonly BranchView[];
}

type AsideT = ReturnType<typeof useAsideT>;

/** What a refused delete says; `reason` is the error's own words, for anything unforeseen. `underIt`: the branch in the way is under it, not itself. */
function refusalText(failure: DeleteBranchFailure, a: AsideT, reason: string, underIt = true): string {
  switch (failure.kind) {
    case "busy":
      return a(underIt ? "delete.busy" : "delete.busySelf");
    case "notDeletable":
      return a("delete.notDeletable");
    case "archived":
      return a("delete.archived");
    default:
      return a("delete.failed", { reason });
  }
}

/**
 * The confirmation for a branch with branches under it: how many go with it,
 * that it cannot be undone, and — refused because one of them is still in
 * progress — the way to that branch.
 */
function ConfirmBody({ confirming, outline, onDeleted, onGo }: { confirming: Confirming; outline: readonly BranchView[]; onDeleted: (lineIds: readonly string[], confirming: Confirming) => void; onGo: (lineId: string) => void }) {
  const a = useAsideT();
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const remove = useDeleteBranch();
  const cancel = useRef<HTMLButtonElement>(null);
  const { branch, under } = confirming;
  const title = branchTitle(branch, t);
  const failure = remove.error ? classifyDeleteBranchError(remove.error) : null;
  // The outline may have been read before that branch was opened: named when it shows one, said either way.
  const busy = failure?.kind === "busy" ? busyBranchUnder(outline, branch.lineId) : null;
  const message = failure ? refusalText(failure, a, describeError(remove.error, t, hostErrorText)) : null;
  return (
    <DialogContent
      width="sm"
      title={a("delete.title", { title })}
      description={a("delete.permanent")}
      initialFocus={cancel}
      footer={
        <>
          <DialogClose render={<Button ref={cancel}>{a("delete.cancel")}</Button>} />
          <Button
            variant="destructive"
            icon={<Trash2 aria-hidden className="size-3.5" />}
            loading={remove.isPending}
            loadingText={a("delete.deleting")}
            onClick={() => !remove.isPending && remove.mutate({ lineId: branch.lineId }, { onSuccess: (result) => onDeleted(result.lineIds, confirming) })}
          >
            {a("delete.confirm")}
          </Button>
        </>
      }
    >
      <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-tg-sm text-tg-foreground">
        <li>{a("delete.withChildren", { count: under.length })}</li>
        <li>{a("delete.keeps")}</li>
      </ul>
      {message && (
        <ErrorAlert>
          <span>{message}</span>
          {busy && (
            <Button size="sm" onClick={() => onGo(busy.lineId)}>
              {a("delete.goBusy", { title: branchTitle(busy, t) })}
            </Button>
          )}
        </ErrorAlert>
      )}
    </DialogContent>
  );
}

/**
 * 刪除支線 and an aside's 丟掉 (F18 §2.1, §2.3), loaded the first time one
 * is asked for and mounted from then on. A branch with branches under it is
 * confirmed first and deleted at once. One without is only hidden, with a
 * toast offering 復原 for five seconds, and sent after that (the server has
 * no undo): sooner when the page goes away, the frame shows another
 * conversation, or this host unmounts — never twice, and not at all once
 * undone. A refusal brings the branch back and says why.
 */
export function BranchDeleteHost({ request, rootId, outline, onGone, navigate, toast }: BranchDeleteHostProps) {
  const a = useAsideT();
  const t = useUiT();
  const ctx = useTangent();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [open, setOpen] = useState(false);
  // What the waits need when they end, whenever that is: the newest props, not the ones of the render that started them.
  const latest = useRef({ a, t, ctx, queryClient, outline, toast, navigate, onGone });
  latest.current = { a, t, ctx, queryClient, outline, toast, navigate, onGone };
  /** The branches waiting, as they were when asked (they leave the outline while they wait). */
  const asked = useRef(new Map<string, { branch: BranchView; outline: readonly BranchView[] }>());

  const deletes = useRef<PendingDeletes | null>(null);
  deletes.current ??= createPendingDeletes({
    send: (item: PendingDelete, leaving: boolean) => {
      const now = latest.current;
      const was = asked.current.get(item.lineId);
      asked.current.delete(item.lineId);
      const target = { queryClient: now.queryClient, keys: now.ctx.keys, live: now.ctx.live };
      now.ctx.client.deleteBranch(item.lineId, leaving ? { keepalive: true } : undefined).then(
        (result) => forgetLines(target, result.rootLineId, result.lineIds),
        (error: unknown) => {
          const failure = classifyDeleteBranchError(error);
          // Already gone (cleared, or deleted elsewhere) is what was asked for.
          if (failure.kind === "gone") return forgetLines(target, item.rootLineId, [item.lineId]);
          now.ctx.live.setHidden([item.lineId], false);
          if (leaving) return;
          const busy = failure.kind === "busy" && was ? busyBranchUnder(was.outline, item.lineId) : null;
          const text = refusalText(failure, now.a, describeError(error, now.t, now.ctx.hostErrorText), busy !== null && busy.lineId !== item.lineId);
          now.toast(text, busy ? { label: now.a("delete.goBusy", { title: branchTitle(busy, now.t) }), run: () => latest.current.navigate(busy.lineId) } : undefined);
        },
      );
    },
  });

  // A new ask: confirm when branches go with it, else hide it and start the wait.
  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.n === handled.current) return;
    handled.current = request.n;
    const branch = outline.find((item) => item.lineId === request.lineId);
    if (!branch) return;
    const under = branchDescendants(outline, branch.lineId);
    if (under.length > 0) {
      setConfirming({ branch, under });
      setOpen(true);
      return;
    }
    if (!deletes.current?.schedule({ lineId: branch.lineId, rootLineId: branch.rootLineId })) return;
    asked.current.set(branch.lineId, { branch, outline });
    // Leave it first if it is on screen, then hide it: nothing shows a branch that is on its way out.
    onGone([branch.lineId]);
    ctx.live.setHidden([branch.lineId], true);
    // The frame shows one toast: it speaks for every delete of this conversation that still waits. Each gets the full
    // time again, and its 復原 takes them all back (the first one's undo used to be lost under the second's toast).
    const together = (deletes.current?.waiting() ?? []).filter((item) => item.rootLineId === branch.rootLineId).map((item) => item.lineId);
    for (const lineId of together) if (lineId !== branch.lineId) deletes.current?.restart(lineId);
    const undo = () => {
      const back = together.filter((lineId) => deletes.current?.undo(lineId));
      if (back.length === 0) return;
      for (const lineId of back) asked.current.delete(lineId);
      latest.current.ctx.live.setHidden(back, false);
      latest.current.toast(back.length > 1 ? latest.current.a("delete.undoneMany", { count: back.length }) : latest.current.a("delete.undone"));
    };
    const allAsides = together.every((lineId) => asked.current.get(lineId)?.branch.kind === "aside");
    const said =
      together.length > 1
        ? a(allAsides ? "delete.asidesGone" : "delete.branchesGone", { count: together.length })
        : branch.kind === "aside"
          ? a("delete.asideGone")
          : a("delete.branchGone", { title: branchTitle(branch, t) });
    toast(said, { label: a("delete.undo"), run: undo }, DELETE_UNDO_MS);
    // Only a new ask starts anything; the rest is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // Another conversation on screen: what waits in the one that was left is sent now.
  useEffect(() => {
    deletes.current?.flush((item) => item.rootLineId !== rootId);
  }, [rootId]);

  // The page goes away, or the frame does: everything waiting is sent, the page's requests marked to outlive it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const leaving = () => deletes.current?.flush(undefined, true);
    window.addEventListener("pagehide", leaving);
    return () => {
      window.removeEventListener("pagehide", leaving);
      mounted.current = false;
      // Not at once: React's development double-mount (StrictMode) cleans up and sets up again in the same task,
      // and a delete asked for a moment ago must keep its wait. A real unmount is still unmounted a microtask later.
      queueMicrotask(() => {
        if (!mounted.current) deletes.current?.flush();
      });
    };
  }, []);

  if (!confirming) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <ConfirmBody
        // Keyed by the branch: a refusal for one never shows on the next.
        key={confirming.branch.lineId}
        confirming={confirming}
        outline={outline}
        onDeleted={(lineIds, done) => {
          setOpen(false);
          onGone(lineIds);
          toast(a("delete.treeGone", { title: branchTitle(done.branch, t), count: done.under.length }));
        }}
        onGo={(lineId) => {
          setOpen(false);
          navigate(lineId);
        }}
      />
    </Dialog>
  );
}
