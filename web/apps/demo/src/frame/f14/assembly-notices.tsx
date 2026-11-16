/**
 * The alerts above and under the F14 structure preview: the overlap warning
 * and the main-line limit warning (each with 改用樹狀圖, decisions #1 and #2),
 * "none has a timestamp", what keeps the import from being sent, and the
 * failures after sending (nothing made; some made, retry just that one).
 */
import {
  allUntimed,
  IMPORT_MAX_BRANCH_MESSAGES,
  IMPORT_MAX_BRANCHES,
  IMPORT_MAX_CHAPTER_CUTS,
  IMPORT_MAX_MESSAGES,
  type AssemblyBlueprint,
  type AssemblyProblem,
  type TimelineSession,
} from "@tangent/client";
import { Button, ErrorAlert } from "@tangent/react";
import { Info } from "lucide-react";
import { useF14T, type F14T } from "./f14-messages";
import { clockOf, dayOf } from "./time-format";
import type { ImportFailure } from "./use-assembly-import";

const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
/** B21: the limits as the texts show them ("2,000"), from the client's constants. */
const limit = (n: number) => n.toLocaleString("en-US");

export function problemText(problem: AssemblyProblem, titleOf: (key: string) => string, t: F14T): string {
  switch (problem.kind) {
    case "noChapter":
      return t("problem.noChapter");
    case "over200":
      return t("problem.over200", { m: problem.messages, limit: limit(IMPORT_MAX_MESSAGES) });
    case "branchTooLong":
      return t("problem.branchTooLong", { title: titleOf(problem.key), n: problem.messages, limit: limit(IMPORT_MAX_BRANCH_MESSAGES) });
    case "sessionTooLong":
      return t("problem.sessionTooLong", { title: titleOf(problem.key), n: problem.messages, limit: limit(IMPORT_MAX_MESSAGES) });
    case "tooManyBranches":
      return t("problem.tooManyBranches", { n: problem.count, limit: limit(IMPORT_MAX_BRANCHES) });
    case "tooManyOpen":
      return t("problem.tooManyOpen", { n: problem.count });
    case "tooManyChapters":
      return t("problem.tooManyChapters", { n: problem.count, limit: limit(IMPORT_MAX_CHAPTER_CUTS) });
    case "cardEmpty":
      return t("problem.cardEmpty", { title: titleOf(problem.key) });
    case "invalidAttach":
      return t("problem.invalidAttach", { title: titleOf(problem.key), target: titleOf(problem.target) });
    case "emptySession":
      return t("problem.emptySession", { title: titleOf(problem.key) });
    case "messageTooLong":
      return t("problem.messageTooLong", { title: titleOf(problem.key), list: problem.numbers.join("、#") });
    case "bodyTooLarge":
      return t("problem.bodyTooLarge", { size: bytes(problem.bytes) });
    case "dateOutOfRange":
      return t("problem.dateOutOfRange", { title: titleOf(problem.key) });
    case "folder":
      return problem.problem === "reserved" ? t("problem.folderReserved") : t("problem.folderTooLong");
    case "tags":
      return problem.problem === "tooMany" ? t("problem.tagsTooMany") : t("problem.tagsTooLong");
  }
}

export interface TopNoticesProps {
  blueprint: AssemblyBlueprint;
  sessions: readonly TimelineSession[];
  titleOf: (key: string) => string;
  onUseTree: () => void;
}

/** Above the preview: the timeline's overlap and main-line limit warnings, and "none has a time". */
export function TopNotices({ blueprint, sessions, titleOf, onUseTree }: TopNoticesProps) {
  const t = useF14T();
  const first = blueprint.interleaves[0];
  const over = blueprint.problems.find((problem) => problem.kind === "over200");
  const useTree = (
    <Button size="sm" variant="ghost" onClick={onUseTree} className="self-start font-medium text-tg-primary-text">
      {t("assembly.useTree")}
    </Button>
  );
  return (
    <>
      {blueprint.mode === "timeline" && first && (
        <ErrorAlert tone="warning">
          <span>{t("assembly.interleave", { b: titleOf(first.inner), time: `${dayOf(first.at)} ${clockOf(first.at)}`, a: titleOf(first.outer) })}</span>
          {useTree}
        </ErrorAlert>
      )}
      {blueprint.mode === "timeline" && over && (
        <ErrorAlert tone="warning">
          <span>
            {t("assembly.over200", { n: sessions.length, m: blueprint.summary.messages, limit: limit(IMPORT_MAX_MESSAGES) })}
            {t("assembly.over200Hint")}
          </span>
          {useTree}
        </ErrorAlert>
      )}
      {allUntimed(sessions) && (
        <p role="status" className="m-0 flex items-start gap-2 rounded-tg-sm border border-tg-border bg-tg-surface px-3 py-2 text-tg-sm text-tg-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-tg-muted" />
          {t("import.allNoTime", { n: sessions.length })}
        </p>
      )}
    </>
  );
}

export interface BottomNoticesProps {
  blueprint: AssemblyBlueprint;
  titleOf: (key: string) => string;
  problemsId: string;
  failure: ImportFailure | null;
  busy: boolean;
  onRetry: () => void;
  onRetryOne: () => void;
  onFinish: () => void;
}

/** Under the preview: why the import is off (the timeline's main-line limit is said above), and what went wrong sending it. */
export function BottomNotices({ blueprint, titleOf, problemsId, failure, busy, onRetry, onRetryOne, onFinish }: BottomNoticesProps) {
  const t = useF14T();
  const listed = blueprint.problems.filter((problem) => !(blueprint.mode === "timeline" && problem.kind === "over200"));
  return (
    <>
      {blueprint.droppedVersions > 0 && <p className="m-0 text-tg-xs text-tg-muted">{t("problem.droppedVersions", { n: blueprint.droppedVersions, limit: limit(IMPORT_MAX_BRANCHES) })}</p>}
      {listed.length > 0 && (
        <div id={problemsId}>
          <ErrorAlert>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {listed.map((problem, index) => (
                <li key={`${problem.kind}-${index}`}>{problemText(problem, titleOf, t)}</li>
              ))}
            </ul>
          </ErrorAlert>
        </div>
      )}
      {failure?.kind === "write" && (
        <ErrorAlert>
          <span>{t("failed.write", { reason: failure.reason })}</span>
          <Button size="sm" className="self-start" disabled={busy} onClick={onRetry}>
            {t("failed.retry")}
          </Button>
        </ErrorAlert>
      )}
      {failure?.kind === "partial" && (
        <ErrorAlert>
          <span>{t("failed.partial", { n: failure.total, k: failure.made, title: failure.title, reason: failure.reason })}</span>
          <span className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={onRetryOne}>
              {t("failed.retryOne")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onFinish}>
              {t("failed.finish")}
            </Button>
          </span>
        </ErrorAlert>
      )}
    </>
  );
}
