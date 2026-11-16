import { branchTitle, isFeatureOn, type Group } from "@tangent/client";
import { Group as GroupIcon, Pencil, RefreshCw, Ungroup } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { IconButton } from "../components/icon-button";
import { INPUT_SURFACE } from "../components/text-field";
import { KIND_KEYS } from "../conversation/branch-suggestions";
import { describeError } from "../conversation/error-text";
import { useDissolveGroup, useGroups, useRenameGroup, useSummarizeGroup } from "../data/group-hooks";
import { useReadOnly } from "../data/live-hooks";
import { useBranches, useCapabilities } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

export interface GroupListProps {
  rootLineId: string;
  /** Goes to a member branch. */
  onGo: (lineId: string) => void;
  /** Only the groups this branch belongs to (focus mode's node panel); nothing when there are none. */
  lineId?: string;
  /** Nothing at all while there is no group (F19 §4: under the outline a 「群組 0」 heading said nothing; groups are made from a selection). */
  hideWhenEmpty?: boolean;
  className?: string;
}

function Summary({ group }: { group: Group }) {
  const t = useP2T();
  if (group.summaryStatus === "drafting") {
    return (
      <p role="status" className="m-0 text-tg-xs text-tg-muted">
        {t("group.drafting")}
      </p>
    );
  }
  return (
    <>
      {group.summaryStatus === "failed" && <p className="m-0 text-tg-xs text-tg-warning">{t("group.failedSummary")}</p>}
      {group.summary ? <p className="m-0 text-tg-xs break-words whitespace-pre-wrap text-tg-foreground">{group.summary}</p> : group.summaryStatus !== "failed" && <p className="m-0 text-tg-xs text-tg-muted">{t("group.noSummary")}</p>}
    </>
  );
}

function GroupItem({ rootLineId, group, onGo }: { rootLineId: string; group: Group; onGo: (lineId: string) => void }) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const readOnly = useReadOnly();
  const outline = useBranches(rootLineId, true);
  const rename = useRenameGroup(rootLineId);
  const dissolve = useDissolveGroup(rootLineId);
  const summarize = useSummarizeGroup(rootLineId);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failed = (failure: unknown) => setError(t("group.failed", { reason: describeError(failure, t, hostErrorText) }));
  const run = (write: () => Promise<unknown>) => {
    setError(null);
    write().catch(failed);
  };
  const byId = new Map((outline.data?.branches ?? []).map((branch) => [branch.lineId, branch]));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setRenaming(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const title = event.currentTarget.value.trim();
      if (!title || title === group.title) return setRenaming(false);
      run(() => rename.mutateAsync({ groupId: group.id, title }).then(() => setRenaming(false)));
    }
  };
  return (
    <article aria-label={t("group.label", { title: group.title })} className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-primary px-2.5 py-2">
      <div className="flex items-center gap-1">
        {renaming ? (
          <input autoFocus aria-label={t("group.title")} defaultValue={group.title} maxLength={120} onKeyDown={onKeyDown} className={cx(INPUT_SURFACE, "h-7 min-w-0 flex-1 px-2 text-tg-sm")} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-tg-sm font-semibold text-tg-foreground">{group.title}</span>
        )}
        {!readOnly && !renaming && <IconButton label={t("group.rename")} icon={<Pencil />} size="sm" onClick={() => setRenaming(true)} />}
        {!readOnly && group.summaryStatus === "failed" && <IconButton label={t("group.resummarize")} icon={<RefreshCw />} size="sm" onClick={() => run(() => summarize.mutateAsync({ groupId: group.id }))} />}
        {!readOnly && <IconButton label={t("group.dissolve")} icon={<Ungroup />} size="sm" onClick={() => run(() => dissolve.mutateAsync({ groupId: group.id }))} />}
      </div>
      <Summary group={group} />
      <ul className="m-0 flex list-none flex-wrap gap-x-2 gap-y-0.5 p-0">
        {group.memberLineIds.map((lineId) => {
          const branch = byId.get(lineId);
          const name = branch ? t("notes.sourceBranch", { kind: t(KIND_KEYS[branch.kind]), title: branchTitle(branch, t) }) : lineId;
          return (
            <li key={lineId}>
              <button
                type="button"
                aria-label={t("relation.go", { title: name })}
                onClick={() => onGo(lineId)}
                className="text-tg-xs text-tg-primary-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11"
              >
                {branch ? branchTitle(branch, t) : lineId}
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="m-0 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </article>
  );
}

/** The tree's groups under the outline (C2): each with its shared summary, members to jump to, rename, re-summarize after a failure, dissolve. */
export function GroupList({ rootLineId, onGo, lineId, hideWhenEmpty = false, className }: GroupListProps) {
  const t = useP2T();
  const headingId = useId();
  const capabilities = useCapabilities();
  const on = isFeatureOn(capabilities.data, "group");
  const groups = useGroups(rootLineId, on);
  if (!on) return null;
  const items = (groups.data?.groups ?? []).filter((group) => lineId === undefined || group.memberLineIds.includes(lineId));
  if ((lineId !== undefined || hideWhenEmpty) && items.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={cx("flex flex-col gap-1.5", className)}>
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-tg-xs font-semibold text-tg-muted">
        <GroupIcon aria-hidden className="size-3.25" />
        {t("groups.title")}
        <span className="font-normal text-tg-subtle">{items.length}</span>
      </h3>
      {groups.isSuccess && items.length === 0 && <p className="m-0 px-1 text-tg-xs text-tg-muted">{t("groups.empty")}</p>}
      {items.map((group) => (
        <GroupItem key={group.id} rootLineId={rootLineId} group={group} onGo={onGo} />
      ))}
    </section>
  );
}
