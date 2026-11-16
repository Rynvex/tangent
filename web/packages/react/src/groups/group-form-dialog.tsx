import {
  BRANCH_PURPOSE_MAX,
  DEFAULT_GROUP_LIMITS,
  branchTitle,
  endingOf,
  groupSuggestionOf,
  isFeatureOn,
  type BranchView,
  type Conflict,
  type ConflictChoice,
  type Suggestion,
} from "@tangent/client";
import { useId, useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogContent } from "../components/dialog";
import { TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useCombineBranches, useCreateGroup } from "../data/group-hooks";
import { useAcceptSuggestion } from "../data/p1-hooks";
import { useCapabilities } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { useTangent } from "../provider";

export type GroupFormMode = "group" | "combine";

export interface GroupFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootLineId: string;
  /** `group`: ended branches under a shared summary; `combine`: open siblings into one new branch. */
  mode: GroupFormMode;
  members: readonly BranchView[];
  /** An AI group suggestion this accepts (its title and conflicts); without it, the user's own selection. */
  suggestion?: Suggestion;
  /** What was made: the group, or the new branch. */
  onDone?: (result: { groupId?: string; lineId?: string }) => void;
}

const runes = (text: string) => Array.from(text.trim()).length;

/** One conflict: three choices (two without notes), arrows move between them (native radios). */
function ConflictChoices({ index, conflict, names, keepBoth, value, onChange }: { index: number; conflict: Conflict; names: (lineId: string) => string; keepBoth: boolean; value: ConflictChoice | undefined; onChange: (choice: ConflictChoice) => void }) {
  const t = useP2T();
  const labelId = useId();
  const name = useId();
  const options: Array<{ choice: ConflictChoice; label: string }> = [
    { choice: "adoptBranch", label: t("conflict.adopt", { title: names(conflict.branch.lineId), claim: conflict.branch.claim }) },
    { choice: "adoptOther", label: t("conflict.adopt", { title: names(conflict.other.lineId), claim: conflict.other.claim }) },
    ...(keepBoth ? [{ choice: "keepBoth" as const, label: t("conflict.keepBoth") }] : []),
  ];
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-1.5 rounded-tg-sm border border-tg-border px-3 py-2.5">
      <span id={labelId} className="text-tg-sm font-medium text-tg-foreground">
        {t("conflict.group", { n: index + 1, branch: conflict.branch.claim, other: conflict.other.claim })}
      </span>
      {options.map((option) => (
        <label key={option.choice} className="flex cursor-pointer items-start gap-2 text-tg-sm text-tg-foreground">
          <input type="radio" name={name} value={option.choice} checked={value === option.choice} onChange={() => onChange(option.choice)} className="mt-1 accent-(--tg-primary)" />
          <span className="min-w-0 break-words">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * 建立群組 / 合併成一條支線 (C2): the branches, a name (or the new branch's
 * purpose), and — for an AI proposal — each conflict decided one by one
 * (採用這條 / 採用那條 / 都保留, the last only with notes on, writing a 待確認
 * note). Combining says the old branches end, marked 「已合併到…」.
 */
export function GroupFormDialog({ open, onOpenChange, rootLineId, mode, members, suggestion, onDone }: GroupFormDialogProps) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const proposal = suggestion ? groupSuggestionOf(suggestion) : null;
  const conflicts = proposal?.conflicts ?? [];
  const keepBoth = isFeatureOn(capabilities.data, "notes");
  const create = useCreateGroup(rootLineId);
  const combine = useCombineBranches(rootLineId);
  const accept = useAcceptSuggestion(rootLineId);
  const [text, setText] = useState(proposal?.title ?? "");
  const [choices, setChoices] = useState<Readonly<Record<string, ConflictChoice>>>({});
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = create.isPending || combine.isPending || accept.isPending;
  const max = mode === "group" ? DEFAULT_GROUP_LIMITS.titleMaxRunes : BRANCH_PURPOSE_MAX;
  const fieldProblem = runes(text) === 0 ? (mode === "group" ? t("group.titleRequired") : t("combine.purposeRequired")) : runes(text) > max ? t("group.titleTooLong", { limit: max }) : null;
  const undecided = conflicts.some((conflict, index) => !choices[conflict.id ?? `c${index + 1}`]);
  const names = (lineId: string) => {
    const branch = members.find((member) => member.lineId === lineId);
    return branch ? branchTitle(branch, t) : (proposal?.members.find((member) => member.lineId === lineId)?.purpose ?? lineId);
  };
  const run = (write: () => Promise<{ groupId?: string; lineId?: string }>) => {
    setError(null);
    write().then(
      (result) => {
        onDone?.(result);
        onOpenChange(false);
      },
      (failure: unknown) => setError(t("group.failed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  const submit = () => {
    setTried(true);
    if (fieldProblem || undecided || pending) return;
    const value = text.trim();
    if (suggestion) {
      return run(async () => {
        const written = await accept.mutateAsync({ suggestionId: suggestion.id, body: { action: mode, ...(mode === "group" ? { title: value } : { purpose: value }), choices } });
        const result = (written.result ?? {}) as { group?: { id?: string }; combined?: { created?: { line?: { id?: string } } } };
        return mode === "group" ? { ...(result.group?.id ? { groupId: result.group.id } : {}) } : { ...(result.combined?.created?.line?.id ? { lineId: result.combined.created.line.id } : {}) };
      });
    }
    const lineIds = members.map((member) => member.lineId);
    if (mode === "group") return run(async () => ({ groupId: (await create.mutateAsync({ memberLineIds: lineIds, title: value })).group.id }));
    return run(async () => ({ lineId: (await combine.mutateAsync({ parentLineId: members[0]?.parentLineId ?? rootLineId, input: { lineIds, purpose: value } })).line.id }));
  };
  const title = mode === "group" ? t("group.createTitle") : t("combine.title");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={mode === "group" ? t("group.createDescription") : t("combine.description")}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("group.cancel")}
            </Button>
            <Button variant="primary" loading={pending} onClick={submit}>
              {mode === "group" ? t("group.create") : t("combine.submit")}
            </Button>
          </>
        }
      >
        <TextField
          label={mode === "group" ? t("group.title") : t("combine.purpose")}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          error={tried || runes(text) > max ? (fieldProblem ?? undefined) : undefined}
        />
        <section className="flex flex-col gap-1.5">
          <h3 className="m-0 text-tg-sm font-medium text-tg-foreground">{t("group.members")}</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {members.map((member) => (
              <li key={member.lineId} className="flex flex-wrap items-baseline gap-x-2 text-tg-sm">
                <span className="text-tg-foreground">{branchTitle(member, t)}</span>
                <span className="text-tg-xs text-tg-muted">{mode === "group" ? endingOf(member) : t("combine.memberEnds")}</span>
              </li>
            ))}
          </ul>
        </section>
        {conflicts.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="m-0 text-tg-sm font-medium text-tg-foreground">{t("conflict.heading")}</h3>
            {conflicts.map((conflict, index) => {
              const id = conflict.id ?? `c${index + 1}`;
              return (
                <ConflictChoices
                  key={id}
                  index={index}
                  conflict={conflict}
                  names={names}
                  keepBoth={keepBoth}
                  value={choices[id]}
                  onChange={(choice) => setChoices((current) => ({ ...current, [id]: choice }))}
                />
              );
            })}
          </section>
        )}
        {((tried && undecided) || error) && (
          <p role="alert" className="m-0 text-tg-sm text-tg-destructive">
            {error ?? t("conflict.required")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
