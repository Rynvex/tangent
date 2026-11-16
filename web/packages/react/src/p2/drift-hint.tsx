import { driftOf, isFeatureOn, type Suggestion } from "@tangent/client";
import { Compass } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/button";
import { describeError } from "../conversation/error-text";
import { useReadOnly } from "../data/live-hooks";
import { useAcceptSuggestion, useDismissSuggestion } from "../data/p1-hooks";
import { useCreateSeed } from "../data/park-hooks";
import { useCapabilities } from "../data/queries";
import { useP2T } from "../i18n/p2-messages";
import { useTangent } from "../provider";

export interface DriftHintProps {
  rootLineId: string;
  /** An open `drift` suggestion about the reply this hint sits under. */
  suggestion: Suggestion;
  /** The branch it opened; the host switches to it. */
  onOpened: (lineId: string) => void;
}

type Action = "open" | "park" | "dismiss";

/**
 * The drift hint (C4): under the reply that strayed, at most one per turn,
 * dashed `--tg-suggestion` like every AI proposal. It asks — open it as the
 * proposed side branch, park it (parking on), or not now — and never opens a
 * dialog or takes focus. A viewer reads it.
 */
export function DriftHint({ rootLineId, suggestion, onOpened }: DriftHintProps) {
  const t = useP2T();
  const { hostErrorText } = useTangent();
  const capabilities = useCapabilities();
  const readOnly = useReadOnly();
  const accept = useAcceptSuggestion(rootLineId);
  const dismiss = useDismissSuggestion(rootLineId);
  const park = useCreateSeed(rootLineId);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drift = driftOf(suggestion);
  if (!drift) return null;
  const kind = drift.kind === "aside" && isFeatureOn(capabilities.data, "aside") ? "aside" : "investigate";
  const run = (action: Action, write: () => Promise<unknown>) => {
    setPending(action);
    setError(null);
    write()
      .catch((failure: unknown) => setError(t("drift.failed", { reason: describeError(failure, t, hostErrorText) })))
      .finally(() => setPending(null));
  };
  const open = () =>
    run("open", async () => {
      const written = await accept.mutateAsync({ suggestionId: suggestion.id, body: { kind } });
      const line = (written.result as { line?: { id?: unknown } } | undefined)?.line;
      if (typeof line?.id === "string") onOpened(line.id);
    });
  const parkIt = () =>
    run("park", async () => {
      await park.mutateAsync({ text: drift.purpose || drift.reason, anchorMessageId: drift.anchorMessageId });
      await dismiss.mutateAsync({ suggestionId: suggestion.id });
    });
  const busy = pending !== null;
  return (
    <div role="group" aria-label={t("drift.label")} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-tg border border-dashed border-tg-suggestion bg-tg-suggestion-soft px-3 py-2 font-tg-sans">
      <Compass aria-hidden className="size-3.5 shrink-0 text-tg-suggestion" />
      <p className="m-0 min-w-0 flex-1 basis-60 text-tg-sm text-tg-foreground">{drift.reason ? t("drift.textReason", { reason: drift.reason }) : t("drift.text")}</p>
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" loading={pending === "open"} disabled={busy && pending !== "open"} onClick={open}>
            {kind === "aside" ? t("drift.openAside") : t("drift.openInvestigate")}
          </Button>
          {isFeatureOn(capabilities.data, "parking") && (
            <Button size="sm" loading={pending === "park"} disabled={busy && pending !== "park"} onClick={parkIt}>
              {t("drift.park")}
            </Button>
          )}
          <Button size="sm" variant="ghost" loading={pending === "dismiss"} disabled={busy && pending !== "dismiss"} onClick={() => run("dismiss", () => dismiss.mutateAsync({ suggestionId: suggestion.id }))}>
            {t("drift.dismiss")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 basis-full text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
