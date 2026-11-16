import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { Term } from "@tangent/client";
import { BookA } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { EXCERPT_PREVIEW_DELAY_MS, EXCERPT_PREVIEW_LEAVE_MS, isCoarse, PreviewPopup } from "../conversation/excerpt-anchor";
import { useGlossaryT } from "../i18n/glossary-messages";
import { useTangentPortalContainer } from "../root/tangent-root";

export interface TermMarkProps {
  term: Term;
  /** Click or Enter (and the sheet's button on touch screens): show the term in the glossary. */
  onOpen: (term: Term) => void;
  children: ReactNode;
}

function Explanation({ term }: { term: Term }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-tg-sm font-medium text-tg-foreground-strong">
        <BookA aria-hidden className="size-3.5 shrink-0 text-tg-muted" />
        {term.term}
      </span>
      <span className="line-clamp-6 text-tg-xs whitespace-pre-wrap text-tg-foreground">{term.explanation}</span>
    </span>
  );
}

/** The phone's bottom sheet: the term, its explanation and the way to the glossary. */
function TermSheet({ term, onClose, onOpen }: { term: Term; onClose: () => void; onOpen: () => void }) {
  const t = useGlossaryT();
  const container = useTangentPortalContainer();
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim" />
        <DialogPrimitive.Popup data-tg-term-sheet="" aria-modal="true" className="fixed inset-x-0 bottom-0 z-50 flex max-h-[80dvh] flex-col gap-3 rounded-t-tg-lg bg-tg-surface-raised px-4 pt-3 pb-5 text-tg-foreground shadow-tg-overlay outline-none">
          <span aria-hidden className="mx-auto h-1 w-9 shrink-0 rounded-tg-full bg-tg-border-strong" />
          <DialogPrimitive.Title className="m-0 flex items-center gap-1.5 text-tg-md font-semibold text-tg-foreground-strong">
            <BookA aria-hidden className="size-4 shrink-0 text-tg-muted" />
            {term.term}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="m-0 min-h-0 overflow-auto text-tg-sm whitespace-pre-wrap text-tg-foreground">{term.explanation}</DialogPrimitive.Description>
          {term.sourceLabel && <span className="text-tg-xs text-tg-muted">{`${t("glossary.source")}・${term.sourceLabel}`}</span>}
          <span className="grid shrink-0 grid-cols-2 gap-2">
            <button type="button" onClick={onOpen} className="h-11 rounded-tg border border-tg-border-input text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
              {t("glossary.openInPanel")}
            </button>
            <DialogPrimitive.Close className="h-11 rounded-tg bg-tg-primary text-tg-sm font-medium text-tg-primary-foreground hover:bg-tg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
              {t("glossary.close")}
            </DialogPrimitive.Close>
          </span>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * A glossary term where a reply uses it (F19 §2.3): a thin dotted underline
 * (the excerpt anchor's line, quieter: no tint, no icon). A pointer resting
 * on it, or keyboard focus, shows the explanation; a click or Enter shows the
 * term in the glossary. On touch screens a tap opens a bottom sheet instead.
 */
export default function TermMark({ term, onOpen, children }: TermMarkProps) {
  const t = useGlossaryT();
  const tooltipId = useId();
  const describedId = useId();
  const [preview, setPreview] = useState(false);
  const [sheet, setSheet] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Moving between the words and the preview keeps it open (WCAG 1.4.13); leaving both closes it.
  const leave = () => {
    clearTimer();
    if (document.activeElement === anchor.current) return;
    timer.current = setTimeout(() => setPreview(false), EXCERPT_PREVIEW_LEAVE_MS);
  };
  const act = () => {
    clearTimer();
    setPreview(false);
    if (isCoarse()) setSheet(true);
    else onOpen(term);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && preview) {
      event.stopPropagation();
      setPreview(false);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    clearTimer();
    setPreview(false);
    onOpen(term);
  };
  return (
    <span
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        clearTimer();
        if (!preview) timer.current = setTimeout(() => setPreview(true), EXCERPT_PREVIEW_DELAY_MS);
      }}
      onPointerLeave={leave}
    >
      <span id={describedId} hidden>
        {t("glossary.markLabel", { term: term.term })}
      </span>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        data-tg-term-mark={term.id}
        // The words stay the name (they are part of the sentence); that they are a known term is the description.
        aria-describedby={preview ? tooltipId : describedId}
        onClick={act}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (!isCoarse()) setPreview(true);
        }}
        onBlur={() => {
          clearTimer();
          setPreview(false);
        }}
        className="cursor-help rounded-[2px] underline decoration-tg-muted decoration-dotted decoration-1 underline-offset-4 [box-decoration-break:clone] hover:decoration-tg-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring"
      >
        {children}
      </span>
      {preview && (
        <PreviewPopup id={tooltipId} anchor={anchor} onPointerEnter={clearTimer} onPointerLeave={leave}>
          <Explanation term={term} />
          <span className="text-tg-xs text-tg-muted">{t("glossary.markHint")}</span>
        </PreviewPopup>
      )}
      {sheet && (
        <TermSheet
          term={term}
          onClose={() => setSheet(false)}
          onOpen={() => {
            setSheet(false);
            onOpen(term);
          }}
        />
      )}
    </span>
  );
}
