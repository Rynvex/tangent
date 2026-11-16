import { branchTitle, type Memo } from "@tangent/client";
import { NodeMemos, useBranches, useFocusT, useLine, useLineMemoRequests, useMemos, useReadOnly, type NodeMemosHandle } from "@tangent/react";
import { useMemo, type Ref } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { checkFlow, continueFlow } from "./memo-flows";

/** At most this many other lines are listed under the line's memos. */
const OTHER_LINES_MAX = 6;

export interface OtherLineMemos {
  lineId: string;
  count: number;
  /** The line's newest memo, shown as a one-line preview. */
  latest: Memo;
}

/** The tree's other lines that have memos, the most recently written first; memos whose line is gone are left out. */
export function otherLineMemos(memos: readonly Memo[], lineId: string): OtherLineMemos[] {
  const byLine = new Map<string, OtherLineMemos>();
  for (const memo of memos) {
    if (memo.lineId === "" || memo.lineId === lineId) continue;
    const seen = byLine.get(memo.lineId);
    byLine.set(memo.lineId, { lineId: memo.lineId, count: (seen?.count ?? 0) + 1, latest: !seen || memo.createdAt >= seen.latest.createdAt ? memo : seen.latest });
  }
  return [...byLine.values()].sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}

/** The other lines' memos, compact: each line's name and count, its newest memo, and the way there. */
function OtherLines({ rootLineId, lineId, navigate }: { rootLineId: string; lineId: string; navigate: Navigate }) {
  const t = useFocusT();
  const memos = useMemos(rootLineId);
  const branches = useBranches(rootLineId, true);
  const root = useLine(rootLineId);
  const lines = useMemo(() => otherLineMemos(memos.data?.memos ?? [], lineId), [memos.data, lineId]);
  const titleOf = (target: string): string | null => {
    if (target === rootLineId) return root.data?.title || t("panel.main");
    const branch = branches.data?.branches.find((item) => item.lineId === target);
    return branch ? branchTitle(branch, t) : null;
  };
  // Only lines the outline still has can be gone to.
  const shown = lines.flatMap((item) => {
    const title = titleOf(item.lineId);
    return title === null ? [] : [{ ...item, title }];
  });
  if (shown.length === 0) return null;
  return (
    <section aria-label={t("memo.otherLines")} className="flex flex-col gap-1.5 border-t border-tg-border pt-3">
      <h3 className="m-0 text-tg-xs font-semibold text-tg-muted">{t("memo.otherLines")}</h3>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {shown.slice(0, OTHER_LINES_MAX).map((item) => (
          <li key={item.lineId}>
            <button
              type="button"
              onClick={() => navigate(item.lineId)}
              className="flex w-full min-w-0 flex-col items-start rounded-tg-sm px-2 py-1.5 text-left hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
            >
              <span className="w-full truncate text-tg-xs font-medium text-tg-primary-text">{t("memo.otherLine", { title: item.title, n: item.count })}</span>
              <span className="w-full truncate text-tg-xs text-tg-muted">{item.latest.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface LineMemosProps {
  rootLineId: string;
  lineId: string;
  /** 轉成紀要 is offered while notes are on. */
  notesOn: boolean;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  ref?: Ref<NodeMemosHandle>;
}

/**
 * The side panel's 備忘 (F10: outside focus mode too): the line's memos with
 * the node panel's actions — 從這裡繼續談…, 請 AI 檢驗理解… (the same
 * Feynman flow) and 轉成紀要 — and, under them, the tree's other lines'.
 */
export function LineMemos({ rootLineId, lineId, notesOn, navigate, onFlow, ref }: LineMemosProps) {
  const readOnly = useReadOnly();
  const root = useLine(rootLineId);
  const writable = !readOnly && !root.data?.archivedAt;
  const requests = useLineMemoRequests(rootLineId, lineId);
  const continueFrom = (text: string) => {
    const request = requests.continueRequest(text);
    if (request) onFlow(continueFlow(request));
  };
  const check = (memo: Memo) => {
    const request = requests.checkRequest(memo);
    if (request) onFlow(checkFlow(request));
  };
  return (
    <div className="flex flex-col gap-3 p-3">
      <NodeMemos
        // Undo, an open add box and marks belong to one line.
        key={lineId}
        {...(ref ? { ref } : {})}
        rootLineId={rootLineId}
        lineId={lineId}
        nodeTitle={requests.nodeTitle}
        readOnly={!writable}
        notesOn={notesOn}
        onContinue={continueFrom}
        {...(writable ? { onCheckUnderstanding: check } : {})}
      />
      <OtherLines rootLineId={rootLineId} lineId={lineId} navigate={navigate} />
    </div>
  );
}
