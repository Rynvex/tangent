import { ArrowUp, Eye, GitBranch, Square, SquareParking, StickyNote } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { formatTokens } from "../components/usage-meter";
import { cx } from "../lib/cx";
import { useCostThreshold, useUiT } from "../provider";
import { isComposing } from "../shortcuts/keys";
import { useOptionalShortcutMatcher, useOptionalShortcutText } from "../shortcuts/shortcuts-provider";
import { formatUsd, isOverThreshold } from "./models";

export interface ComposerEstimate {
  tokens: number;
  /** Input cost of the turn when the server has a price for the model. */
  costUsd?: number | undefined;
}

export interface ComposerProps {
  /** The draft; the host owns it so it survives reconnects and line switches. */
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Called with the trimmed text; the box clears at once. When the returned
   * promise rejects, the text comes back (unless something new was typed).
   */
  onSend: (content: string) => void | Promise<unknown>;
  /** A reply is streaming: the send button becomes a stop button and Esc stops. */
  streaming?: boolean;
  onStop?: () => void;
  onBranch?: () => void;
  /** Only when the parking feature is on (P1). */
  onPark?: () => void;
  /**
   * 存成備忘 (the memo feature, F10), offered while there is a draft: called
   * with the trimmed text. The box clears when the promise resolves to
   * anything but `false` (and nothing new was typed meanwhile); `false` or a
   * rejection keeps the draft (the host says why).
   */
  onMemo?: (content: string) => Promise<unknown>;
  onPreview?: () => void;
  /** From `usePreview` for the current draft. */
  estimate?: ComposerEstimate | null;
  /** Defaults to the provider's threshold. */
  costThreshold?: number;
  disabled?: boolean;
  placeholder?: string;
  /** A send error, shown under the box. */
  error?: string | null;
  /**
   * The host's model control (G1: provider / model and reasoning effort),
   * first in the toolbar. The composer only places it; the host owns what it
   * shows and does.
   */
  modelControl?: ReactNode;
  /**
   * The keys' hint under the box, in the host's words (G2: a host whose
   * settings change the send key says the keys as they are now). Left out,
   * the bundled "Enter to send · Shift+Enter for a new line" shows.
   */
  hint?: string;
  /**
   * A draft can be sent while a reply streams (G2 "stop and send"): with
   * text in the box the button stays 送出 and the send key works; the host's
   * `onSend` stops the reply first. Without text the button is still 停止.
   */
  sendWhileStreaming?: boolean;
  className?: string;
}

/** Enter / Shift+Enter, or the host's bindings for composer.send and composer.newline. */
function useKeys() {
  const matcher = useOptionalShortcutMatcher();
  return {
    isSend: (event: KeyboardEvent) => (matcher ? matcher(event, "composer.send") : event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey),
  };
}

/**
 * The message box (components.md: r lg, min h 88): Enter sends (never while
 * an input method composes), Shift+Enter breaks the line, the send button
 * turns into stop while a reply streams (Esc stops too). With a draft it
 * shows the token estimate; the cost appears, in the warning colour, only
 * above the user's threshold (handoff §9-6).
 */
export function Composer(props: ComposerProps) {
  const { value, onValueChange, onSend, streaming = false, onStop, onBranch, onPark, onMemo, onPreview, estimate, disabled = false, placeholder, error, modelControl, hint, sendWhileStreaming = false, className } = props;
  const t = useUiT();
  const threshold = useCostThreshold();
  const keys = useKeys();
  const branchKeys = useOptionalShortcutText("branch.open");
  const errorId = useId();
  // The draft as of the last render, read when a failed send wants to put its text back.
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  });
  const text = value.trim();
  // While a reply streams the box only stops it, unless the host takes a follow-up then (it stops the reply itself).
  const interrupts = streaming && sendWhileStreaming && text !== "";
  const canSend = text !== "" && (!streaming || interrupts) && !disabled;
  const showStop = streaming && !interrupts;
  const [savingMemo, setSavingMemo] = useState(false);

  const send = () => {
    if (!canSend) return;
    const restore = () => {
      if (latest.current === "") onValueChange(value);
    };
    onValueChange("");
    latest.current = "";
    try {
      Promise.resolve(onSend(text)).catch(restore);
    } catch {
      // A host handler that throws synchronously must not lose the draft either.
      restore();
    }
  };

  const saveMemo = () => {
    if (!onMemo || text === "" || savingMemo) return;
    const asked = value;
    setSavingMemo(true);
    onMemo(text).then(
      (result) => {
        setSavingMemo(false);
        if (result !== false && latest.current === asked) onValueChange("");
      },
      () => setSavingMemo(false),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Escape" && streaming && onStop) {
      event.preventDefault();
      onStop();
      return;
    }
    if (!keys.isSend(event)) return;
    event.preventDefault();
    send();
  };

  const over = isOverThreshold(estimate?.costUsd, props.costThreshold ?? threshold);
  const tokensText = estimate && text ? t("usage.tokens", { count: formatTokens(estimate.tokens) }) : null;
  const previewLabel = tokensText ? `${t("command.turn.preview")} (${tokensText})` : t("command.turn.preview");

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex min-h-22 flex-col rounded-tg-lg border border-tg-border-input bg-tg-surface-raised shadow-tg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tg-ring">
        <textarea
          data-tg-composer=""
          aria-label={t("composer.label")}
          aria-describedby={error ? errorId : undefined}
          value={value}
          disabled={disabled}
          placeholder={placeholder ?? t("composer.placeholder")}
          rows={2}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-[40vh] min-h-12 w-full resize-none border-0 bg-transparent px-3.5 pt-3 pb-1 text-tg-md leading-normal text-tg-foreground outline-none [field-sizing:content] placeholder:text-tg-subtle disabled:opacity-45"
        />
        <div className="flex flex-wrap items-center gap-0.5 px-1.5 pt-1 pb-1.5">
          {modelControl}
          {onBranch && (
            <Button variant="ghost" size="sm" icon={<GitBranch aria-hidden className="size-3.5" />} className="text-tg-primary-text" onClick={onBranch} disabled={disabled}>
              {t("command.branch.open")}
            </Button>
          )}
          {onPark && (
            <Button variant="ghost" size="sm" icon={<SquareParking aria-hidden className="size-3.5" />} onClick={onPark} disabled={disabled}>
              {t("composer.park")}
            </Button>
          )}
          {onMemo && text !== "" && (
            <Button variant="ghost" size="sm" icon={<StickyNote aria-hidden className="size-3.5" />} loading={savingMemo} onClick={saveMemo} disabled={disabled}>
              {t("composer.memo")}
            </Button>
          )}
          <span className="tg-kbd-hint min-w-0 flex-1 truncate px-1.5 text-tg-xs text-tg-subtle">{hint ?? t("composer.hint", { branchKey: branchKeys ?? "" })}</span>
          {over && estimate?.costUsd !== undefined && (
            <span title={t("composer.costTitle", { threshold: formatUsd(props.costThreshold ?? threshold) })} className="px-1 font-tg-mono text-tg-xs text-tg-warning">
              {t("composer.cost", { cost: formatUsd(estimate.costUsd) })}
            </span>
          )}
          {onPreview && (
            <Button variant="ghost" size="sm" aria-label={previewLabel} icon={<Eye aria-hidden className="size-3.5" />} onClick={onPreview}>
              {tokensText && <span className="font-tg-mono">{tokensText}</span>}
            </Button>
          )}
          {/* One button that changes between send and stop, so keyboard focus stays on it when a reply starts or ends. */}
          <IconButton
            label={showStop ? t("composer.stop") : t("composer.send")}
            icon={showStop ? <Square className="fill-current" /> : <ArrowUp />}
            round
            variant={showStop ? "ghost" : "primary"}
            aria-disabled={!showStop && !canSend ? true : undefined}
            onClick={() => (showStop ? onStop?.() : send())}
            className={showStop ? "border border-tg-border-strong bg-tg-surface text-tg-foreground" : undefined}
          />
        </div>
      </div>
      {error && (
        <p id={errorId} role="alert" className="m-0 px-1 text-tg-xs text-tg-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
