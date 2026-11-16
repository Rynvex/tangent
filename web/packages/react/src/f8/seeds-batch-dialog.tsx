import { charCount, markdownListItems, SEED_BATCH_MAX, SEED_OPEN_MAX, SEED_TEXT_MAX, type CreateSeedsBatchInput, type Message } from "@tangent/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../components/button";
import { Skeleton } from "../components/display";
import { Dialog, DialogClose, DialogContent } from "../components/dialog";
import { describeError } from "../conversation/error-text";
import { invalidateAll } from "../data/park-hooks";
import { useSeeds } from "../data/p1-hooks";
import { useF8T } from "../i18n/f8-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

/** `POST /lines/{id}/seeds/batch` (B14): all parked or none; the parking lot and the 待處理 count follow. */
export function useCreateSeedsBatch(lineId: string, rootLineId: string) {
  const { client, keys } = useTangent();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSeedsBatchInput) => client.createSeedsBatch(lineId, input),
    onSuccess: (result) => invalidateAll(queryClient, keys.seedsOf(result.rootLineId || rootLineId), keys.lineView(result.rootLineId || rootLineId)),
  });
}

export interface SeedsBatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootLineId: string;
  /** The line the reply is on (the seeds' anchor line). */
  lineId: string;
  /** The reply whose Markdown list is parked. */
  message: Message;
  /** Parked: the host says so (「已存 n 顆到停車場。看停車場」). */
  onDone: (count: number) => void;
}

interface Row {
  text: string;
  checked: boolean;
}

/**
 * 把清單存入停車場 (S11, components.md `SeedsBatchDialog`): every top-level
 * item of the reply's list, at most 20, each with a check box and a text box
 * (click to edit). The parking lot's room shows all along; at first only as
 * many items as there are free spots are ticked (decision #14), and more
 * than that cannot be sent, so `409 seed_limit` is not the first warning.
 */
export function SeedsBatchDialog({ open, onOpenChange, ...rest }: SeedsBatchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SeedsForm key={`${rest.lineId}:${rest.message.id}`} onOpenChange={onOpenChange} {...rest} />
    </Dialog>
  );
}

function SeedsForm({ rootLineId, lineId, message, onOpenChange, onDone }: Omit<SeedsBatchDialogProps, "open">) {
  const t = useF8T();
  const { hostErrorText } = useTangent();
  const seeds = useSeeds(rootLineId);
  const save = useCreateSeedsBatch(lineId, rootLineId);
  const items = markdownListItems(message.content);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!seeds.data) {
    return (
      <DialogContent width="md" title={t("seeds.title")}>
        {seeds.isError ? (
          <p role="alert" className="m-0 text-tg-sm text-tg-destructive">
            {t("seeds.failed", { reason: describeError(seeds.error, t, hostErrorText) })}
          </p>
        ) : (
          <Skeleton className="h-32 w-full" />
        )}
      </DialogContent>
    );
  }
  const max = seeds.data.limits.maxOpen || SEED_OPEN_MAX;
  const maxRunes = seeds.data.limits.maxRunes || SEED_TEXT_MAX;
  const current = seeds.data.seeds.filter((seed) => seed.status === "open").length;
  const room = Math.max(0, max - current);
  const listed = items.slice(0, SEED_BATCH_MAX);
  const shown = rows ?? listed.map((text, index) => ({ text, checked: index < room }));
  const ticked = shown.filter((row) => row.checked);
  const over = ticked.length - room;
  const rowProblem = (row: Row) => (row.text.trim() === "" ? t("seeds.empty") : charCount(row.text.trim()) > maxRunes ? t("seeds.tooLong", { max: maxRunes }) : null);
  const invalid = ticked.some((row) => rowProblem(row) !== null);
  const blocked = ticked.length === 0 || over > 0 || invalid;
  const update = (index: number, change: Partial<Row>) => setRows(shown.map((row, at) => (at === index ? { ...row, ...change } : row)));
  const submit = () => {
    if (blocked || save.isPending) return;
    setError(null);
    save.mutateAsync({ anchorMessageId: message.id, texts: ticked.map((row) => row.text.trim()) }).then(
      (result) => {
        onOpenChange(false);
        onDone(result.seeds.length);
      },
      (failure: unknown) => setError(t("seeds.failed", { reason: describeError(failure, t, hostErrorText) })),
    );
  };
  return (
    <DialogContent
      width="md"
      title={t("seeds.title")}
      description={t("seeds.description")}
      footer={
        <>
          <DialogClose render={<Button>{t("seeds.cancel")}</Button>} />
          <Button variant="primary" loading={save.isPending} aria-disabled={blocked || undefined} onClick={submit}>
            {t("seeds.submit", { n: ticked.length })}
          </Button>
        </>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {shown.map((row, index) => {
          const problem = row.checked ? rowProblem(row) : null;
          return (
            // The item's place is its identity: the texts are the user's to change.
            <li key={index} className={cx("flex min-h-10 items-start gap-2.5 rounded-tg-sm border px-2.5 py-1.5 pointer-coarse:min-h-12", problem ? "border-tg-destructive" : "border-tg-border hover:border-tg-border-strong", !row.checked && "opacity-60")}>
              <input
                type="checkbox"
                aria-label={t("seeds.include", { n: index + 1 })}
                checked={row.checked}
                onChange={(event) => update(index, { checked: event.currentTarget.checked })}
                className="mt-1.5 size-4 shrink-0 accent-(--tg-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <input
                  aria-label={t("seeds.item", { n: index + 1 })}
                  aria-invalid={problem ? true : undefined}
                  value={row.text}
                  onChange={(event) => update(index, { text: event.currentTarget.value })}
                  className="w-full rounded-tg-sm border border-transparent bg-transparent px-1 py-1 text-tg-sm text-tg-foreground hover:border-tg-border-input focus-visible:border-tg-border-input focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring"
                />
                {problem && <span className="px-1 text-tg-xs text-tg-destructive">{problem}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {items.length > SEED_BATCH_MAX && <p className="m-0 text-tg-xs text-tg-muted">{t("seeds.firstOnly", { max: SEED_BATCH_MAX })}</p>}
      <p role="status" className="m-0 text-tg-xs text-tg-muted">
        {room === 0 ? t("seeds.full") : t("seeds.capacity", { n: current, max, k: ticked.length, left: Math.max(0, room - ticked.length) })}
      </p>
      {over > 0 && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-3 py-2 text-tg-sm text-tg-foreground">
          {t("seeds.overLimit", { left: room, k: ticked.length, over })}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 rounded-tg-sm bg-tg-destructive-soft px-3 py-2 text-tg-sm text-tg-foreground">
          {error}
        </p>
      )}
    </DialogContent>
  );
}
