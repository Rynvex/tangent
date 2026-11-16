import { useEffect, useRef, useState, type RefObject } from "react";

/** A message to bring into view and highlight; `n` changes on every request, even for the same message. */
export interface MessageFocus {
  messageId: string;
  n: number;
}

/** How long a message stays highlighted after a jump. */
const HIGHLIGHT_MS = 2500;

/**
 * Scrolls the requested message into view once it is rendered and highlights
 * it for a moment (fork links, card links, "go to that message").
 */
export function useMessageFocus(container: RefObject<HTMLElement | null>, focus: MessageFocus | null, ready: boolean, onJump?: () => void): string | null {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const jumped = useRef(false);
  useEffect(() => {
    if (!focus || !ready) return undefined;
    const row = container.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focus.messageId)}"]`);
    if (!row) return undefined;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // The first jump after the line opened (a pasted address, a link from another line) lands at once: the
    // rows are still taking their real height, and a smooth scroll would chase a moving target.
    row.scrollIntoView({ block: "center", behavior: reduce || !jumped.current ? "auto" : "smooth" });
    jumped.current = true;
    // The bottom-following scroller must not pull the view back while the rows around the message lay out.
    onJump?.();
    setHighlighted(focus.messageId);
    const timer = setTimeout(() => setHighlighted(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [container, focus, ready, onJump]);
  return highlighted;
}
