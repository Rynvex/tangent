/**
 * The frame's F8 state (6_FRONTEND_F8.md): the in-tree search bar, the
 * export and shortcut dialogs, the composer's note after a prefill, and the
 * palette commands they bring. The parts themselves are in `f8-slots.tsx`,
 * loaded the first time one opens.
 */
import { isFeatureOn } from "@tangent/client";
import { useCapabilities, useCommand } from "@tangent/react";
import { lazy, useState } from "react";
import { useHasKeyboard } from "./has-keyboard";

export const SearchSlot = lazy(() => import("./f8-slots").then((module) => ({ default: module.SearchSlot })));
export const DialogSlot = lazy(() => import("./f8-slots").then((module) => ({ default: module.DialogSlot })));

const composerBox = () => document.querySelector<HTMLTextAreaElement>("main textarea[data-tg-composer]");

export interface F8FrameInput {
  rootId: string | null;
  readOnly: boolean;
  onReview: () => void;
  onLibrary: () => void;
  onNew: () => void;
  onToggleTheme: () => void;
  /** 跳到支線: the side panel's outline. */
  onOutline: () => void;
  /** Writes a line's composer draft. */
  setDraft: (lineId: string, text: string) => void;
}

export function useF8Frame({ rootId, readOnly, onReview, onLibrary, onNew, onToggleTheme, onOutline, setDraft }: F8FrameInput) {
  const capabilities = useCapabilities();
  const hasKeyboard = useHasKeyboard();
  const [dialog, setDialog] = useState<"shortcuts" | "export" | null>(null);
  // The bar belongs to one conversation: another one on screen closes it (and an open dialog).
  const [search, setSearch] = useState<{ root: string; focused: boolean; jumped: string | null; token: number } | null>(null);
  const [seenRoot, setSeenRoot] = useState(rootId);
  if (seenRoot !== rootId) {
    setSeenRoot(rootId);
    setSearch(null);
    setDialog(null);
  }
  const searchOpen = search !== null && search.root === rootId;
  const [notice, setNotice] = useState<{ lineId: string; text: string } | null>(null);
  // Opening it again (⌘F with the bar open but focus elsewhere) brings focus back to its box.
  const openSearch = () =>
    rootId && setSearch((current) => (current?.root === rootId ? { ...current, focused: true, token: current.token + 1 } : { root: rootId, focused: true, jumped: null, token: 0 }));
  const patch = (change: Partial<{ focused: boolean; jumped: string | null }>) => setSearch((current) => (current ? { ...current, ...change } : current));
  useCommand("shortcuts.help", () => setDialog("shortcuts"), hasKeyboard);
  // Decision #11: with the bar open and focus in it, a second ⌘F is the browser's.
  useCommand("search.inTree", openSearch, rootId !== null && !(searchOpen && search.focused));
  useCommand("export.open", () => setDialog("export"), rootId !== null);
  useCommand("review.open", onReview, rootId !== null);
  useCommand("memory.open", onLibrary, isFeatureOn(capabilities.data, "memory"));
  useCommand("conversation.new", onNew, !readOnly);
  useCommand("theme.toggle", onToggleTheme);
  useCommand("nav.toBranch", onOutline, rootId !== null);
  return {
    searchOpen,
    openSearch,
    /** Closing gives focus to the composer (the bar's box is gone). */
    closeSearch: () => {
      setSearch(null);
      requestAnimationFrame(() => composerBox()?.focus());
    },
    searchToken: search?.token ?? 0,
    onJumped: (jumped: string | null) => patch({ jumped }),
    onSearchFocus: (focused: boolean) => patch({ focused }),
    /** The message the search jumped to: its fold opens while the bar is open. */
    expandMessageId: searchOpen ? search.jumped : null,
    dialog,
    openExport: () => setDialog("export"),
    closeDialog: () => setDialog(null),
    noticeFor: (lineId: string) => (notice?.lineId === lineId ? notice.text : null),
    dismissNotice: () => setNotice(null),
    /** Text into a line's composer (never sent), with a note when given; the flow that called it focuses the composer. */
    prefill: (lineId: string, text: string, note?: string) => {
      setDraft(lineId, text);
      setNotice(note ? { lineId, text: note } : null);
    },
  };
}
