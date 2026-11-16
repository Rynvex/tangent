import { RELATION_LABEL_MAX, goalLine, type Link, type RelationKind } from "@tangent/client";
import { useState } from "react";
import { Button } from "../components/button";
import { Dialog, DialogContent } from "../components/dialog";
import { Select, type SelectOption } from "../components/select";
import { TextField } from "../components/text-field";
import { describeError } from "../conversation/error-text";
import { useCreateRelation, useRelations } from "../data/p2-hooks";
import { useLines } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { useTangent } from "../provider";
import { useLineNames } from "./line-names";
import { RelationKindPicker } from "./relation-kinds";

/** Where a relation starts: a line of this tree, or one of its messages, with its name as shown. */
export interface RelationStart {
  lineId: string;
  messageId?: string;
  label: string;
}

export interface RelationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootLineId: string;
  from: RelationStart;
  onCreated?: (relation: Link) => void;
}

/** The other end's choices: this tree's lines (not the start itself), then other conversations. */
function useTargets(rootLineId: string, from: RelationStart): SelectOption<string>[] {
  const lines = useLines();
  const { name, branches } = useLineNames(rootLineId);
  const here = [rootLineId, ...branches.filter((branch) => branch.kind !== "aside" || branch.status === "open").map((branch) => branch.lineId)]
    .filter((lineId) => lineId !== from.lineId || Boolean(from.messageId))
    .map((lineId) => ({ value: lineId, label: name(lineId) }));
  const others = (lines.data?.lines ?? []).filter((line) => line.id !== rootLineId && !line.conversationBranch).map((line) => ({ value: line.id, label: name(line.id, line.title) }));
  return [...here, ...others];
}

/**
 * 建立關聯 (C3) without dragging, from a message's action or the outline's
 * relation list: the start is given, the other end is chosen from this
 * conversation's lines or another conversation, with its kind (B15: 相關 by
 * default) and an optional note (the server's limit). AI is not told; the next preview lists it. The choice and
 * the note belong to one start in one conversation (R9 G1).
 */
export function RelationDialog(props: RelationDialogProps) {
  return <StartRelationDialog key={`${props.rootLineId}:${props.from.lineId}:${props.from.messageId ?? ""}`} {...props} />;
}

function StartRelationDialog({ open, onOpenChange, rootLineId, from, onCreated }: RelationDialogProps) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const relations = useRelations(rootLineId);
  const create = useCreateRelation(rootLineId);
  const targets = useTargets(rootLineId, from);
  const [to, setTo] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<RelationKind>("related");
  const [error, setError] = useState<string | null>(null);
  const max = relations.data?.limits.labelMaxRunes ?? RELATION_LABEL_MAX;
  const length = Array.from(goalLine(label)).length;
  const tooLong = length > max;
  const ready = to !== null && !tooLong;
  const submit = () => {
    if (!ready || create.isPending) return;
    setError(null);
    create
      .mutateAsync({ fromLineId: from.lineId, ...(from.messageId ? { fromMessageId: from.messageId } : {}), toLineId: to, ...(kind !== "related" ? { relationKind: kind } : {}), ...(goalLine(label) ? { label: goalLine(label) } : {}) })
      .then(
        (result) => {
          onCreated?.(result.relation);
          onOpenChange(false);
        },
        (failure: unknown) => setError(t("relation.failed", { reason: describeError(failure, t, hostErrorText) })),
      );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={t("relation.dialogTitle")}
        description={t("relation.dialogDescription")}
        width="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("relation.cancel")}
            </Button>
            <Button variant="primary" loading={create.isPending} aria-disabled={!ready || undefined} onClick={submit}>
              {t("relation.create")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-tg-sm font-medium text-tg-foreground">{t("relation.from")}</span>
          <span className="text-tg-sm text-tg-muted">{from.label}</span>
        </div>
        <Select label={t("relation.to")} options={targets} value={to} onValueChange={setTo} placeholder={t("relation.toPlaceholder")} />
        <div className="flex flex-col gap-1.5">
          <span aria-hidden className="text-tg-sm font-medium text-tg-foreground">
            {t("relation.kindField")}
          </span>
          <RelationKindPicker value={kind} onValueChange={setKind} className="self-start" />
          {kind === "contradicts" && <span className="text-tg-xs text-tg-muted">{t("relation.kindHint")}</span>}
        </div>
        <TextField
          label={t("relation.labelField")}
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          description={t("relation.labelCount", { count: length, limit: max })}
          error={tooLong ? t("relation.labelTooLong", { limit: max }) : undefined}
        />
        {error && (
          <p role="alert" className="m-0 text-tg-sm text-tg-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
