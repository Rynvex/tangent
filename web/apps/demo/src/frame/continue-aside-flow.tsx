import { asideAnswer, classifyContinueError, type BranchView, type ContinueAsideFailure } from "@tangent/client";
import { Button, describeError, Dialog, DialogClose, DialogContent, useBranchDetail, useContinueAside, useMessages, useTangent, useUiT } from "@tangent/react";
import { useEffect, useRef, useState } from "react";
import { useAsideT } from "./aside-messages";
import type { BranchFlow, Navigate } from "./branch-flows";
import { focusComposerSoon } from "./composer-focus";
import { expectedGone } from "./expected-gone";

export interface ContinueAsideFlowProps {
  /** The answered aside. */
  lineId: string;
  close: () => void;
  navigate: Navigate;
  toast: (message: string) => void;
  /** The older way on, offered when 接著問 is refused: an investigate branch from the aside's fork point. */
  openFlow: (flow: BranchFlow) => void;
}

/** What a refusal says (the reason itself for anything unforeseen). */
function failureText(failure: ContinueAsideFailure, a: ReturnType<typeof useAsideT>, reason: string): string {
  switch (failure.kind) {
    case "branchLimit":
      return a("continue.branchLimit", { limit: failure.limit });
    case "treeLimit":
      return a("continue.treeLimit", { limit: failure.limit });
    case "deeper":
      return a("continue.deeper", { depth: failure.depth, limit: failure.limit });
    case "other":
      return a("continue.other", { reason });
    default:
      return a(`continue.${failure.kind}`);
  }
}

/**
 * 接著問 (F18 §2.1): no dialog when it goes through — the aside becomes a
 * branch, the frame goes there and the composer takes focus. While it runs
 * the aside's line is expected to go (`expectedGone`), so the frame does not
 * leave for somewhere else first. A refusal is said in a small dialog: a
 * deeper branch can be confirmed, a change under us tried again, and for the
 * rest the older way stays open (an investigate branch from the same place).
 */
export default function ContinueAsideFlow({ lineId, close, navigate, toast, openFlow }: ContinueAsideFlowProps) {
  const a = useAsideT();
  const t = useUiT();
  const { hostErrorText } = useTangent();
  const run = useContinueAside();
  const detail = useBranchDetail(lineId);
  const messages = useMessages(lineId);
  // The aside as it was: its queries go with its line while the request runs.
  const aside = useRef<{ branch: BranchView | null; answer: string }>({ branch: null, answer: "" });
  if (detail.data) aside.current = { ...aside.current, branch: detail.data.branch };
  if (messages.data) aside.current = { ...aside.current, answer: asideAnswer(messages.data.messages)?.content ?? aside.current.answer };
  const [failure, setFailure] = useState<{ kind: ContinueAsideFailure; error: unknown } | null>(null);
  const started = useRef(false);

  const ask = (confirmDeeper = false) => {
    setFailure(null);
    expectedGone.add(lineId);
    run.mutateAsync({ lineId, ...(confirmDeeper ? { input: { confirmDeeper: true } } : {}) }).then(
      (result) => {
        navigate(result.line.id);
        expectedGone.delete(lineId);
        close();
        focusComposerSoon();
      },
      (error: unknown) => {
        expectedGone.delete(lineId);
        const kind = classifyContinueError(error);
        // Nothing left to act on: said in passing.
        if (kind.kind === "gone") {
          toast(a("continue.gone"));
          return close();
        }
        setFailure({ kind, error });
      },
    );
  };
  // Once (a ref: StrictMode's second effect run must not ask again).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!failure) return null;
  const { branch, answer } = aside.current;
  const kind = failure.kind.kind;
  const fallback = branch && kind !== "archived" && kind !== "deeper" && kind !== "retry" && kind !== "busy";
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        width="sm"
        title={a("continue.failedTitle")}
        footer={
          <>
            <DialogClose render={<Button>{a("continue.close")}</Button>} />
            {fallback && (
              <Button
                onClick={() =>
                  openFlow({
                    kind: "open",
                    lineId: branch.parentLineId,
                    request: { anchorMessageId: branch.anchorMessageId, ...(answer ? { excerpt: answer } : {}), purpose: branch.purpose, question: "", notice: a("asideEnd.followNotice", { purpose: branch.purpose }) },
                  })
                }
              >
                {a("continue.openInstead")}
              </Button>
            )}
            {kind === "deeper" && (
              <Button variant="primary" loading={run.isPending} onClick={() => ask(true)}>
                {a("continue.anyway")}
              </Button>
            )}
            {(kind === "retry" || kind === "busy") && (
              <Button variant="primary" loading={run.isPending} onClick={() => ask()}>
                {a("continue.again")}
              </Button>
            )}
          </>
        }
      >
        <p role="alert" className="m-0 text-tg-sm text-tg-foreground">
          {failureText(failure.kind, a, describeError(failure.error, t, hostErrorText))}
        </p>
      </DialogContent>
    </Dialog>
  );
}
