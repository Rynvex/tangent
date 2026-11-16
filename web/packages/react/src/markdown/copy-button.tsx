// Markdown renderer component).
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useUiT } from "../provider";

const COPIED_RESET_MS = 1500;
type CopyState = "idle" | "copied" | "failed";

/** Copies `text`; the label says "Copied" (or that it failed) for a moment. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useUiT();
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_RESET_MS);
  };

  const shown = state === "copied" ? t("markdown.copied") : state === "failed" ? t("markdown.copyFailed") : t("markdown.copy");
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label ?? t("markdown.copyCode")}
      data-tg-copy=""
      className="inline-flex min-h-6 items-center gap-1 rounded-tg-sm px-1.5 text-tg-xs text-tg-muted hover:bg-tg-accent hover:text-tg-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:min-h-11 pointer-coarse:px-3"
    >
      {state === "copied" ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      <span aria-live="polite">{shown}</span>
    </button>
  );
}
