import { TAG_DRAFTS_MAX, branchTitle, chatNumbers, isFeatureOn, purposeHead, type BranchView, type MessagePage, type TagDraft, type TagKind } from "@tangent/client";
import { useQueryClient } from "@tanstack/react-query";
import { Tags } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/button";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import { useTagDrafts, useTagMessage } from "../data/p3-hooks";
import { useBranches, useCapabilities } from "../data/queries";
import { useF8T } from "../i18n/f8-messages";
import { TAG_KIND_KEYS, TAG_TEXT } from "../p3/tag-kinds";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

/** Characters of each message shown on its row. */
const SNIPPET_CHARS = 60;
/** How long 全部確認 can be undone (interactions: 復原). */
export const ARG_UNDO_MS = 10_000;

export interface ArgReviewCardProps {
  rootLineId: string;
  /** The line on screen (kept for the host's key; the list is the whole tree's since B15). */
  lineId: string;
  /** Goes to a draft's message, on any line of the tree (its row, 逐一看). */
  onGoTo: (lineId: string, messageId: string) => void;
}

interface Row {
  draft: TagDraft;
  place: string;
}

/** One type 全部確認 wrote, to put back with 復原. */
interface Written {
  lineId: string;
  messageId: string;
  kind: TagKind;
}

/** What 全部確認 confirmed (every press within the undo window), to put back with 復原. */
interface Confirmed {
  items: Written[];
}

/** The tree's drafts (B15 `GET /tag-drafts`) with where each is: the line's name and, when that line is loaded, the message's #n. */
function useRows(rootLineId: string, drafts: readonly TagDraft[], branches: readonly BranchView[]): Row[] {
  const t = useF8T();
  const { keys } = useTangent();
  const queryClient = useQueryClient();
  return useMemo(() => {
    const numbers = new Map<string, ReadonlyMap<string, number>>();
    const numberOf = (draft: TagDraft) => {
      if (!numbers.has(draft.lineId)) numbers.set(draft.lineId, chatNumbers(queryClient.getQueryData<MessagePage>(keys.messages(draft.lineId))?.messages ?? []));
      return numbers.get(draft.lineId)!.get(draft.messageId);
    };
    return drafts.map((draft) => {
      const branch = draft.lineId === rootLineId ? undefined : branches.find((item) => item.lineId === draft.lineId);
      const line = branch ? t("search.branch", { title: branchTitle(branch, t) }) : t("search.main");
      const n = numberOf(draft);
      return { draft, place: n === undefined ? line : t("inbox.argPlace", { line, n }) };
    });
  }, [rootLineId, drafts, branches, t, keys, queryClient]);
}

/**
 * 論證類型待確認 (S2, components.md `InboxArgReviewCard`): the drafts AI
 * tagged anywhere in the tree and the user has not looked at (B15), one
 * press to confirm them all — undone for ARG_UNDO_MS by 復原, which puts
 * each back as a draft — or one by one from their rows, which go to the
 * message on its own line. Dashed --tg-suggestion like every unconfirmed AI
 * proposal; not shown without drafts, with ibis off, or to a viewer.
 */
export function ArgReviewCard({ rootLineId, onGoTo }: ArgReviewCardProps) {
  const t = useF8T();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const on = isFeatureOn(capabilities.data, "ibis") && !readOnly;
  const outline = useBranches(rootLineId, on);
  const list = useTagDrafts(rootLineId, on);
  const rows = useRows(rootLineId, list.data?.drafts ?? [], outline.data?.branches ?? []);
  const tag = useTagMessage(rootLineId);
  const { keys } = useTangent();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmed) return undefined;
    const timer = setTimeout(() => setConfirmed(null), ARG_UNDO_MS);
    return () => clearTimeout(timer);
  }, [confirmed]);
  if (!on) return null;

  /** One write at a time, each awaiting its own result (R7); returns the ones that went through, the ones refused and the first reason. */
  const writeEach = async (items: readonly Written[], status: "confirmed" | "draft") => {
    const done: Written[] = [];
    const failed: Written[] = [];
    let reason = "";
    for (const item of items) {
      try {
        await tag.mutateAsync({ messageId: item.messageId, kind: item.kind, ...(status === "draft" ? { status } : {}) });
        done.push(item);
      } catch (failure) {
        failed.push(item);
        reason ||= describeError(failure, t, hostErrorText);
      }
    }
    return { done, failed, reason };
  };

  /** Still the type 全部確認 wrote? A line on screen tells (the user may have changed it since); one not loaded is taken as unchanged. */
  const unchanged = (item: Written) => {
    const message = queryClient.getQueryData<MessagePage>(keys.messages(item.lineId))?.messages.find((entry) => entry.id === item.messageId);
    return !message || (message.tag?.kind === item.kind && message.tag.status === "confirmed");
  };

  const confirmAll = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const { done, failed, reason } = await writeEach(
      rows.map(({ draft }) => ({ lineId: draft.lineId, messageId: draft.messageId, kind: draft.tag.kind })),
      "confirmed",
    );
    setBusy(false);
    // A second press within the window adds to what 復原 puts back (and restarts the window).
    setConfirmed((before) => (done.length > 0 || before ? { items: [...(before?.items ?? []), ...done] } : null));
    if (failed.length > 0) setError(t("inbox.confirmPartial", { done: done.length, failed: failed.length, reason }));
  };

  const undo = async () => {
    if (busy || !confirmed) return;
    const kept = confirmed.items.filter((item) => !unchanged(item));
    setBusy(true);
    setError(null);
    setConfirmed(null);
    const { done, failed, reason } = await writeEach(confirmed.items.filter(unchanged), "draft");
    setBusy(false);
    const undone = t("inbox.undone", { n: done.length });
    setNotice(kept.length > 0 ? `${undone}${t("inbox.undoKept", { n: kept.length })}` : undone);
    if (failed.length === 0) return;
    // The refused ones stay for another 復原.
    setConfirmed({ items: failed });
    setError(t("inbox.undoPartial", { done: done.length, failed: failed.length, reason }));
  };

  const status = (
    <div role="status" className="text-tg-xs text-tg-muted empty:hidden">
      {confirmed ? (
        <span className="flex items-center gap-2 rounded-tg-sm bg-tg-surface-sunken px-3 py-1.5">
          <span className="flex-1">{t("inbox.confirmedN", { n: confirmed.items.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => void undo()}>
            {t("inbox.undo")}
          </Button>
        </span>
      ) : (
        notice && <span className="block rounded-tg-sm bg-tg-surface-sunken px-3 py-2">{notice}</span>
      )}
    </div>
  );
  const alert = error && (
    <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-2.5 py-1.5 text-tg-xs text-tg-foreground">
      {error}
    </p>
  );
  // One wrapper whether or not drafts are left, so the status region stays mounted after 全部確認 empties the list.
  if (rows.length === 0 && !confirmed && !notice && !error) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.length > 0 && (
        <section aria-label={t("inbox.argReview")} className="flex flex-col gap-2.5 rounded-tg border border-dashed border-tg-suggestion bg-tg-surface p-3">
          <span className="flex items-center gap-1.5 text-tg-sm font-semibold text-tg-foreground">
            <Tags aria-hidden className="size-3.5 text-tg-suggestion" />
            {t("inbox.argReview")}
          </span>
          <p className="m-0 text-tg-xs text-tg-muted">
            {t("inbox.argReviewBody", { n: rows.length })}
            {list.data?.truncated && ` ${t("inbox.argTruncated", { n: TAG_DRAFTS_MAX })}`}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {rows.map(({ draft, place }) => (
              <li key={draft.messageId}>
                <button
                  type="button"
                  onClick={() => onGoTo(draft.lineId, draft.messageId)}
                  className="flex min-h-8.5 w-full items-center gap-2 rounded-tg-sm px-2 py-1 text-left hover:bg-tg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
                >
                  <span className={cx("inline-flex h-5 shrink-0 items-center rounded-[4px] border border-dashed px-1.5 text-[0.6875rem]", TAG_TEXT[draft.tag.kind])}>{t(TAG_KIND_KEYS[draft.tag.kind])}</span>
                  <span className="shrink-0 text-tg-xs text-tg-muted">{place}</span>
                  <span className="min-w-0 flex-1 truncate text-tg-xs text-tg-foreground">{purposeHead(draft.content, SNIPPET_CHARS)}</span>
                </button>
              </li>
            ))}
          </ul>
          <span className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void confirmAll()}>
              {t("inbox.confirmAll")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => rows[0] && onGoTo(rows[0].draft.lineId, rows[0].draft.messageId)}>
              {t("inbox.reviewOne")}
            </Button>
          </span>
        </section>
      )}
      {status}
      {alert}
    </div>
  );
}
