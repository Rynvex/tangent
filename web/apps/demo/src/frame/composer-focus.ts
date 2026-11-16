/** F8: focusing the composer after a flow put text in it (the lazy branch flows only). */
const composerBox = () => document.querySelector<HTMLTextAreaElement>("main textarea[data-tg-composer]");

/**
 * Focuses the composer once the new line's view has mounted, and keeps it
 * there for a moment: the dialog that led here gives focus back to its
 * trigger as it closes (about half a second at most). The user's own
 * pointer or key ends it at once.
 */
export function focusComposerSoon(frames = 40): void {
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  window.addEventListener("pointerdown", stop, { capture: true, once: true });
  window.addEventListener("keydown", stop, { capture: true, once: true });
  const step = (left: number) => {
    if (stopped) return;
    const box = composerBox();
    if (box && document.activeElement !== box) box.focus();
    if (left > 0) requestAnimationFrame(() => step(left - 1));
    else {
      window.removeEventListener("pointerdown", stop, { capture: true });
      window.removeEventListener("keydown", stop, { capture: true });
    }
  };
  step(frames);
}

