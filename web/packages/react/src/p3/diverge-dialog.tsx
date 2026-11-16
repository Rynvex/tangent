import { Working } from "../components/working";
import { DIVERGE_COUNT, DIVERGE_MODELS_COUNT, type Message } from "@tangent/client";
import { useEffect, useId, useState, type ReactNode } from "react";
import { SegmentedControl } from "../components/segmented-control";
import { DivergeModelsPanel, useDivergeModelChoices } from "../f8/diverge-models";
import { useF8T } from "../i18n/f8-messages";
import { Button } from "../components/button";
import { Dialog, DialogContent } from "../components/dialog";
import { describeError } from "../conversation/error-text";
import { useDiverge } from "../data/diverge-hooks";
import { useJobFailure } from "../data/live-hooks";
import { useBranches } from "../data/queries";
import { useP3T } from "../i18n/p3-messages";
import { cx } from "../lib/cx";
import { useTangent } from "../provider";

export interface DivergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line the reply is on (the directions hang on it). */
  lineId: string;
  rootLineId: string;
  /** The reply the directions fork from. */
  anchor: Message;
  /** The line's messages: 跨模型平行比較 offers the reply's question (F8 S8). Without them only the AI's directions are offered. */
  messages?: readonly Message[];
  /** Which way to diverge first (the palette's 跨模型平行比較…); otherwise the last one used on this device. */
  initialMode?: DivergeMode;
}

export type DivergeMode = "ai" | "models";

/** The last way used, on this device (S8: 記住上次的選擇). */
const MODE_KEY = "tangent:diverge-mode:v1";

function storedMode(): DivergeMode | null {
  try {
    const value = window.localStorage.getItem(MODE_KEY);
    return value === "ai" || value === "models" ? value : null;
  } catch {
    return null;
  }
}

function storeMode(mode: DivergeMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage blocked: the choice lasts until the dialog closes.
  }
}

/** The 「AI 提出幾個方向｜跨模型平行比較」 switch; the models side needs two allowed models (it says why when not). */
function ModeSwitch({ mode, onMode, models }: { mode: DivergeMode; onMode: (mode: DivergeMode) => void; models: number }) {
  const t = useF8T();
  const usable = models >= DIVERGE_MODELS_COUNT.min;
  return (
    <div className="flex flex-col gap-1">
      <SegmentedControl
        label={t("diverge.modeLabel")}
        options={[
          { value: "ai" as const, label: t("diverge.modeAi") },
          { value: "models" as const, label: t("diverge.modeModels"), disabled: !usable },
        ]}
        value={mode}
        onValueChange={onMode}
      />
      {!usable && <p className="m-0 text-tg-xs text-tg-muted">{t("diverge.modelsUnavailable", { n: models })}</p>}
    </div>
  );
}

const COUNTS = Array.from({ length: DIVERGE_COUNT.max - DIVERGE_COUNT.min + 1 }, (_, index) => DIVERGE_COUNT.min + index);
const DEFAULT_COUNT = 3;

/**
 * 給我幾個方向 (D3): 2–5 directions from a reply, opened by AI as sibling
 * branches all at once. The dialog waits until they are there (or the job
 * failed) and then closes; nothing happens unless the user asks.
 */
export default function DivergeDialog(props: DivergeDialogProps) {
  return <ModeDivergeDialog key={`${props.lineId}:${props.anchor.id}`} {...props} />;
}

function ModeDivergeDialog(props: DivergeDialogProps) {
  const models = useDivergeModelChoices().length;
  const [chosen, setChosen] = useState<DivergeMode>(() => props.initialMode ?? storedMode() ?? "ai");
  const mode: DivergeMode = chosen === "models" && models >= DIVERGE_MODELS_COUNT.min && props.messages ? "models" : "ai";
  const onMode = (next: DivergeMode) => {
    setChosen(next);
    storeMode(next);
  };
  const switcher = props.messages ? <ModeSwitch mode={mode} onMode={onMode} models={models} /> : null;
  // One dialog for both ways: switching only swaps its content (focus and the open dialog stay).
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {mode === "models" && props.messages ? (
        <DivergeModelsPanel lineId={props.lineId} anchor={props.anchor} messages={props.messages} switcher={switcher} onClose={() => props.onOpenChange(false)} />
      ) : (
        <AiDirections {...props} switcher={switcher} />
      )}
    </Dialog>
  );
}

/** 「AI 提出幾個方向」: how many directions, then AI's job opens them all. */
function AiDirections({ onOpenChange, lineId, rootLineId, anchor, switcher }: DivergeDialogProps & { switcher: ReactNode }) {
  const t = useP3T();
  const { hostErrorText } = useTangent();
  const diverge = useDiverge(lineId);
  const outline = useBranches(rootLineId, true);
  const name = useId();
  const labelId = useId();
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [asked, setAsked] = useState<{ jobId: string; before: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failure = useJobFailure(asked?.jobId ?? null);
  const opened = (outline.data?.branches ?? []).filter((branch) => branch.parentLineId === lineId && branch.origin === "diverge" && branch.anchorMessageId === anchor.id).length;
  // The job opens all of them in one go: once they are in the outline, the dialog is done.
  const done = asked !== null && !failure && opened >= asked.before + count;
  useEffect(() => {
    if (done) onOpenChange(false);
  }, [done, onOpenChange]);
  const failed = failure ? t("diverge.failed", { reason: failure.error.message || failure.error.code }) : error;
  const waiting = asked !== null && !failure;
  const submit = () => {
    if (diverge.isPending || waiting) return;
    setError(null);
    diverge.mutateAsync({ anchorMessageId: anchor.id, count }).then(
      (job) => setAsked({ jobId: job.jobId, before: opened }),
      (reason: unknown) => setError(t("diverge.failed", { reason: describeError(reason, t, hostErrorText) })),
    );
  };
  return (
    <DialogContent
      title={t("diverge.dialogTitle")}
      description={t("diverge.dialogDescription")}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("diverge.cancel")}
          </Button>
          <Button variant="primary" loading={diverge.isPending || waiting} onClick={submit}>
            {t("diverge.submit", { count })}
          </Button>
        </>
      }
    >
      {switcher}
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-2">
        <span id={labelId} className="text-tg-sm font-medium text-tg-foreground">
          {t("diverge.count")}
        </span>
        <div className="flex gap-2">
          {COUNTS.map((value) => (
            <label key={value} className={cx("flex h-9 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-tg-sm border px-3 text-tg-sm pointer-coarse:h-11", value === count ? "border-tg-primary bg-tg-primary-soft text-tg-primary-text" : "border-tg-border-strong text-tg-foreground")}>
              <input type="radio" name={name} value={value} checked={value === count} disabled={waiting} onChange={() => setCount(value)} className="accent-(--tg-primary)" />
              {value}
            </label>
          ))}
        </div>
      </div>
      {waiting && (
        <p role="status" className="m-0 text-tg-sm">
          <Working>{t("diverge.waiting", { count })}</Working>
        </p>
      )}
      {failed && (
        <p role="alert" className="m-0 text-tg-sm text-tg-destructive">
          {failed}
        </p>
      )}
    </DialogContent>
  );
}

export { DivergeDialog };
