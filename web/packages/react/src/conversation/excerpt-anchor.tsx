import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { branchTitle, type BranchStatus, type BranchView } from "@tangent/client";
import { CornerDownRight } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useF12T } from "../i18n/f12-messages";
import { cx } from "../lib/cx";
import { useTangentPortalContainer } from "../root/tangent-root";
import { branchStatusKey, isAsideLeaf } from "./aside-leaf";
import { KIND_ICONS, KIND_KEYS } from "./branch-suggestions";

/** Decision #11 / S2: the preview waits this long under a pointer (focus shows it at once). */
export const EXCERPT_PREVIEW_DELAY_MS = 300;
/** Room kept between the preview and its words, and from the window's edges. */
const PREVIEW_GAP_PX = 6;
const EDGE_PX = 16;
/** Leaving the words for the preview (or back) within this long keeps it open. */
const PREVIEW_LEAVE_MS = 120;

/** How much of an aside's answer the phone's sheet quotes. */
const ANSWER_START_CHARS = 40;

/** S2: the underline's colour follows the newest branch (open, merged, an aside). */
const LINE: Record<BranchStatus, string> = {
  open: "decoration-tg-branch-open",
  merged: "decoration-tg-branch-merged",
  discarded: "decoration-tg-branch-discarded",
  promoted: "decoration-tg-branch-promoted",
};

export interface ExcerptAnchorProps {
  /** The branches opened from these words, newest first. */
  branches: readonly BranchView[];
  /** The newest is an aside open in place under the message (S1). */
  open: boolean;
  /** The newest's answer start (an aside), for the phone's sheet. */
  answer?: string | undefined;
  /** Click or Enter: an aside opens in place, another branch is entered (the newest). */
  onAct: (branch: BranchView) => void;
  /** The sheet's 完整畫面 (asides): enter it. */
  onFullView?: ((branch: BranchView) => void) | undefined;
  children: ReactNode;
}

/** Leaving the words for the preview (or back) within this long keeps it open. */
export const EXCERPT_PREVIEW_LEAVE_MS = PREVIEW_LEAVE_MS;

/** Touch screens have no hover: a tap opens the sheet first (decision #11). */
export function isCoarse(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
  } catch {
    return false;
  }
}

function Summary({ branch }: { branch: BranchView }) {
  const t = useF12T();
  const conclusion = branch.leaf?.line || branch.conclusionLine;
  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-1.5 text-tg-xs text-tg-muted">
        <span aria-hidden className="flex [&_svg]:size-3">
          {KIND_ICONS[branch.kind]}
        </span>
        {t(KIND_KEYS[branch.kind])}
        <span aria-hidden>・</span>
        {t(branchStatusKey(branch))}
        <span aria-hidden>・</span>
        {t("excerpt.messages", { count: branch.messageCount })}
      </span>
      <span className="text-tg-sm font-medium text-tg-foreground-strong">{branchTitle(branch, t)}</span>
      {conclusion && <span className="line-clamp-2 text-tg-xs text-tg-foreground">{conclusion}</span>}
    </span>
  );
}

/**
 * Where the preview goes: under the words, or above them when the window
 * has no room below; never past the window's sides. Fixed in a portal, so a
 * row's paint containment (`content-visibility`) or a scroller never clips it.
 */
export function previewPlacement(words: { left: number; top: number; bottom: number }, size: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number; above: boolean } {
  const left = Math.max(EDGE_PX, Math.min(words.left, view.width - size.width - EDGE_PX));
  const below = words.bottom + PREVIEW_GAP_PX;
  const above = below + size.height > view.height - EDGE_PX && words.top - PREVIEW_GAP_PX - size.height >= EDGE_PX;
  return { left, top: above ? words.top - PREVIEW_GAP_PX - size.height : below, above };
}

/** The floating preview under (or above) its words; F19 reuses it for a known term's explanation. */
export function PreviewPopup({ id, anchor, onPointerEnter, onPointerLeave, children }: { id: string; anchor: RefObject<HTMLElement | null>; onPointerEnter: () => void; onPointerLeave: () => void; children: ReactNode }) {
  const container = useTangentPortalContainer();
  const box = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Placed when it opens, and again whenever anything scrolls or the window resizes, so it follows its words.
  useLayoutEffect(() => {
    const update = () => {
      const words = anchor.current?.getBoundingClientRect();
      const popup = box.current?.getBoundingClientRect();
      if (!words || !popup) return;
      setPlace(previewPlacement(words, popup, { width: window.innerWidth, height: window.innerHeight }));
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor]);
  const host = container ?? (typeof document !== "undefined" ? document.body : null);
  if (!host) return null;
  return createPortal(
    <span
      ref={box}
      id={id}
      role="tooltip"
      data-tg-excerpt-preview=""
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: "hidden" }}
      className="fixed z-50 flex w-[min(21.25rem,calc(100vw-2rem))] flex-col gap-2 rounded-tg border border-tg-border bg-tg-surface-raised px-3 py-2.5 font-tg-sans text-tg-sm text-tg-foreground shadow-tg-overlay"
    >
      {children}
    </span>,
    host,
  );
}

/** The phone's bottom sheet: what the words lead to, then 在這裡展開 / 進入支線. */
function ExcerptSheet({ branch, answer, onClose, onAct, onFullView }: { branch: BranchView; answer: string | undefined; onClose: () => void; onAct: () => void; onFullView: (() => void) | undefined }) {
  const t = useF12T();
  const container = useTangentPortalContainer();
  const aside = isAsideLeaf(branch);
  const start = answer ? Array.from(answer.replace(/\s+/g, " ").trim()) : [];
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim" />
        <DialogPrimitive.Popup aria-modal="true" className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-3 rounded-t-tg-lg bg-tg-surface-raised px-4 pt-3 pb-5 text-tg-foreground shadow-tg-overlay outline-none">
          <span aria-hidden className="mx-auto h-1 w-9 rounded-tg-full bg-tg-border-strong" />
          <DialogPrimitive.Title className="m-0 flex items-center gap-1.5 text-tg-xs font-normal text-tg-muted">
            <span aria-hidden className="flex [&_svg]:size-3.5">
              {KIND_ICONS[branch.kind]}
            </span>
            {t("excerpt.sheetTag", { kind: aside ? t("aside.inlineTag") : t(KIND_KEYS[branch.kind]), status: t(branchStatusKey(branch)) })}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="m-0 flex flex-col gap-1">
            <span className="text-tg-md font-semibold text-tg-foreground-strong">{branchTitle(branch, t)}</span>
            {aside && start.length > 0 && (
              <span className="text-tg-sm text-tg-muted">{t("excerpt.answerStart", { text: `${start.slice(0, ANSWER_START_CHARS).join("")}${start.length > ANSWER_START_CHARS ? "…" : ""}` })}</span>
            )}
            {!aside && (branch.leaf?.line || branch.conclusionLine) && <span className="text-tg-sm text-tg-muted">{branch.leaf?.line || branch.conclusionLine}</span>}
          </DialogPrimitive.Description>
          <button
            type="button"
            onClick={onAct}
            className="inline-flex h-11 items-center justify-center rounded-tg bg-tg-primary px-4 text-tg-sm font-medium text-tg-primary-foreground hover:bg-tg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring"
          >
            {aside ? t("excerpt.openHere") : t("excerpt.enter")}
          </button>
          <span className="grid grid-cols-2 gap-2">
            {aside && onFullView ? (
              <button type="button" onClick={onFullView} className="h-11 rounded-tg border border-tg-border-input text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
                {t("excerpt.fullView")}
              </button>
            ) : (
              <span />
            )}
            <DialogPrimitive.Close className="h-11 rounded-tg border border-tg-border-input text-tg-sm hover:bg-tg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring">
              {t("excerpt.cancel")}
            </DialogPrimitive.Close>
          </span>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * S2 ExcerptAnchor / ExcerptPreview: the words a branch was opened from,
 * dashed underline in its status colour on a faint accent, a 10px
 * CornerDownRight after them (and a count when two or more branches share
 * them). Desktop: a pointer resting 300ms (or keyboard focus, at once) shows
 * the preview (w340: kind, status, messages, title, conclusion, what a click
 * does); a click or Enter opens an aside here (S1) or enters the branch.
 * Touch: a tap opens a bottom sheet first. The preview does not fade in.
 */
export default function ExcerptAnchor({ branches, open, answer, onAct, onFullView, children }: ExcerptAnchorProps) {
  const t = useF12T();
  const tooltipId = useId();
  const describedId = useId();
  const [preview, setPreview] = useState(false);
  const [sheet, setSheet] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const newest = branches[0];
  if (!newest) return <>{children}</>;
  const aside = isAsideLeaf(newest);
  const hint = aside ? t("excerpt.hintAside") : t("excerpt.hintBranch");
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const act = () => {
    clearTimer();
    setPreview(false);
    if (isCoarse()) setSheet(true);
    else onAct(newest);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && preview) {
      event.stopPropagation();
      setPreview(false);
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    // The keyboard never needs the sheet: Enter acts at once.
    clearTimer();
    setPreview(false);
    onAct(newest);
  };
  const more = branches.length - 1;
  // Moving between the words and the preview keeps it open (WCAG 1.4.13); leaving both closes it.
  const leave = () => {
    clearTimer();
    if (document.activeElement === anchor.current) return;
    timer.current = setTimeout(() => setPreview(false), PREVIEW_LEAVE_MS);
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
        {t("excerpt.label", { kind: t(KIND_KEYS[newest.kind]), title: branchTitle(newest, t), status: t(branchStatusKey(newest)), hint })}
      </span>
      <span
        ref={anchor}
        role="button"
        tabIndex={0}
        data-tg-excerpt={newest.lineId}
        data-tg-excerpt-open={open ? "" : undefined}
        // The words stay the name (they are part of the sentence); what they lead to is the description.
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
        className={cx(
          "cursor-pointer rounded-[2px] underline decoration-dashed decoration-[1.5px] underline-offset-4 [box-decoration-break:clone] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tg-ring",
          aside ? "decoration-tg-leaf-answer" : LINE[newest.status],
          open || preview ? "bg-tg-primary-soft" : "bg-tg-accent hover:bg-tg-primary-soft",
        )}
      >
        {children}
        <CornerDownRight aria-hidden className="ml-0.5 inline size-2.5 align-baseline text-tg-muted" />
        {more > 0 && (
          <span aria-hidden className="ml-0.5 font-tg-sans text-[0.625rem] text-tg-muted">
            {branches.length}
          </span>
        )}
      </span>
      {preview && (
        <PreviewPopup id={tooltipId} anchor={anchor} onPointerEnter={clearTimer} onPointerLeave={leave}>
          <Summary branch={newest} />
          {more > 0 && (
            <span className="flex flex-col gap-1 border-t border-tg-border pt-1.5">
              <span className="text-tg-xs text-tg-muted">{t("excerpt.more", { count: more })}</span>
              {branches.slice(1, 4).map((other) => (
                <span key={other.lineId} className="truncate text-tg-xs text-tg-foreground">
                  {branchTitle(other, t)}・{t(branchStatusKey(other))}
                </span>
              ))}
            </span>
          )}
          <span className="text-tg-xs text-tg-primary-text">{hint}</span>
        </PreviewPopup>
      )}
      {sheet && (
        <ExcerptSheet
          branch={newest}
          answer={answer}
          onClose={() => setSheet(false)}
          onAct={() => {
            setSheet(false);
            onAct(newest);
          }}
          onFullView={
            onFullView
              ? () => {
                  setSheet(false);
                  onFullView(newest);
                }
              : undefined
          }
        />
      )}
    </span>
  );
}
