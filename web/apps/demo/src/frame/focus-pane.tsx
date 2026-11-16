import { prependToDraft, useFocusT, useMessages } from "@tangent/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { BranchFlow, Navigate } from "./branch-flows";
import { FocusMap } from "./focus-map";
import { CHAT_MIN_PX, chatWidth, defaultChatShare, limitOf, MAP_MIN_PX, nextRegion, panelPlacement, shareForKey } from "./focus-split";
import type { FocusPrefs } from "./focus-state";
import type { FocusLayout } from "./layout";

export type FocusTab = "chat" | "map";

export interface FocusPaneProps {
  layout: FocusLayout;
  tab: FocusTab;
  onTab: (tab: FocusTab) => void;
  rootLineId: string;
  lineId: string;
  windowWidth: number;
  prefs: FocusPrefs;
  onPrefs: (prefs: FocusPrefs) => void;
  navigate: Navigate;
  onFlow: (flow: BranchFlow) => void;
  /** The line on screen's composer draft (帶進這一輪 writes into it). */
  draft: { get: () => string; set: (value: string) => void };
  focusComposer: () => void;
  toast: (message: string) => void;
  onShowAllNotes: () => void;
}

/** The regions F6 walks (§10): the chat, the map, the node panel when open. */
const REGIONS = ['[data-tg-focus-region="chat"]', '[data-tg-focus-region="map"]', '[data-tg-focus-region="panel"]'];

function regionElements(): HTMLElement[] {
  return REGIONS.flatMap((selector) => {
    const found = document.querySelector<HTMLElement>(selector);
    return found ? [found] : [];
  });
}

/** F6 / ⇧F6 move between the chat, the map and the node panel (Tab keeps its usual order). */
function useRegionKeys() {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "F6" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const regions = regionElements();
      const active = document.activeElement;
      // The panel sits inside the map: the innermost region holding focus counts.
      const current = regions.findLastIndex((region) => region.contains(active));
      const next = regions[nextRegion(regions.length, current, event.shiftKey)];
      if (!next) return;
      event.preventDefault();
      const target = next.querySelector<HTMLElement>("[data-tg-map-canvas], textarea, button:not([disabled]), [tabindex='0']");
      if (target) target.focus();
      else {
        next.tabIndex = -1;
        next.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** On narrow frames the chat stays mounted under the map: out of reach for the keyboard and assistive tech meanwhile. */
function useChatBehindMap(covered: boolean) {
  useEffect(() => {
    const chat = document.querySelector<HTMLElement>('[data-tg-focus-region="chat"]');
    if (!covered || !chat) return;
    chat.inert = true;
    return () => {
      chat.inert = false;
    };
  }, [covered]);
}

/** The width of the element's parent, followed as the window or the frame changes. */
function useParentWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setWidth(parent.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

interface SeparatorProps {
  share: number;
  total: number;
  chat: number;
  /** The split's left edge on screen (where a drag measures from). */
  left: () => number;
  /** While dragging: shown at once, not yet kept. */
  onDrag: (share: number) => void;
  /** Kept (keys, the end of a drag). */
  onShare: (share: number) => void;
  onReset: () => void;
}

/** The split's handle (§4.2): drag, ←/→ by 5 %, Home/End to either minimum, double-click back to the default. */
function Separator({ share, total, chat, left, onDrag, onShare, onReset }: SeparatorProps) {
  const t = useFocusT();
  const dragging = useRef<number | null>(null);
  const [active, setActive] = useState(false);
  const limit = limitOf(total, chat);
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === null) return;
    dragging.current = Math.min(1, Math.max(0, (event.clientX - left()) / total));
    onDrag(dragging.current);
  };
  // Released, cancelled or capture lost: the drag ends and its share is kept once.
  const stop = () => {
    const last = dragging.current;
    dragging.current = null;
    setActive(false);
    if (last !== null) onShare(last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = shareForKey(event.key, share, total);
    if (next === null) return;
    event.preventDefault();
    onShare(next);
  };
  const percent = Math.round((chat / total) * 100);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("focus.splitter")}
      aria-valuemin={Math.round((CHAT_MIN_PX / total) * 100)}
      aria-valuemax={Math.round(((total - MAP_MIN_PX) / total) * 100)}
      aria-valuenow={percent}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        dragging.current = share;
        setActive(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      className="group/split relative z-20 w-1.5 shrink-0 cursor-col-resize touch-none bg-tg-border hover:bg-tg-border-strong focus-visible:bg-tg-ring focus-visible:outline-none"
    >
      <span aria-hidden className="absolute top-1/2 left-1/2 h-8 w-1 -translate-1/2 rounded-tg-full bg-tg-border-strong" />
      {active && limit && (
        // At a minimum the hint sits on the handle, reaching into the side that still has room (S14b).
        <span role="status" className={`absolute top-[calc(50%-2.5rem)] rounded-tg-sm bg-tg-foreground-strong px-2 py-1 text-tg-xs whitespace-nowrap text-tg-background ${limit === "chat" ? "left-2" : "right-2"}`}>
          {limit === "chat" ? t("focus.chatMin", { px: CHAT_MIN_PX }) : t("focus.mapMin", { px: MAP_MIN_PX })}
        </span>
      )}
    </div>
  );
}

/** Narrow frames (§4.3): 對話｜地圖 under the header, with a dot on 對話 while its reply streams. */
export function FocusTabs({ tab, onTab, lineId }: { tab: FocusTab; onTab: (tab: FocusTab) => void; lineId: string }) {
  const t = useFocusT();
  const messages = useMessages(lineId);
  const replying = (messages.data?.messages ?? []).some((message) => message.status === "pending");
  const tabs: { id: FocusTab; label: string; dot: boolean }[] = [
    { id: "chat", label: t("focus.tabChat"), dot: replying && tab !== "chat" },
    { id: "map", label: t("focus.tabMap"), dot: false },
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "chat" ? "map" : "chat";
    onTab(next);
    requestAnimationFrame(() => event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
  };
  return (
    <div className="flex shrink-0 justify-center border-b border-tg-border bg-tg-background px-3 py-1.5">
      <div role="radiogroup" aria-label={t("focus.tabs")} onKeyDown={onKeyDown} className="flex gap-0.5 rounded-tg-sm bg-tg-surface-sunken p-0.5">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            data-tab={item.id}
            aria-checked={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => onTab(item.id)}
            className={`relative flex h-7 min-w-24 items-center justify-center gap-1.5 rounded-tg-sm px-3 text-tg-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring pointer-coarse:h-11 ${tab === item.id ? "bg-tg-surface-raised text-tg-foreground shadow-tg" : "text-tg-muted"}`}
          >
            {item.label}
            {item.dot && (
              <>
                <span aria-hidden className="size-1.5 rounded-tg-full bg-tg-primary" />
                <span className="sr-only">{t("focus.replying")}</span>
              </>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Focus mode's map side (FOCUS_MODE.md §4): beside the chat with a handle
 * from 1024 up (the chat column keeps its own width rules), or over the chat
 * while 地圖 is chosen on narrow frames. Following and the split are kept in
 * the browser; a focused subtree and the chosen node belong to one visit.
 */
export function FocusPane(props: FocusPaneProps) {
  const { layout, tab, onTab, rootLineId, lineId, windowWidth, prefs, onPrefs, navigate, onFlow, draft, focusComposer, toast, onShowAllNotes } = props;
  const t = useFocusT();
  const { ref, width: total } = useParentWidth();
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [dragShare, setDragShare] = useState<number | null>(null);
  useRegionKeys();
  useChatBehindMap(layout === "tabs" && tab === "map");
  const share = dragShare ?? prefs.chatShare ?? defaultChatShare(windowWidth);
  const chat = chatCollapsed ? CHAT_MIN_PX : chatWidth(total, share);
  const mapWidth = Math.max(0, total - chat);
  const enter: Navigate = (target, messageId) => {
    navigate(target, messageId);
    if (layout === "tabs") onTab("chat");
  };
  const map = (place: "float" | "bottom" | "sheet") => (
    <FocusMap
      rootLineId={rootLineId}
      lineId={lineId}
      place={place}
      follow={prefs.follow}
      onFollowChange={(follow) => onPrefs({ ...prefs, follow })}
      notesLayer={prefs.notesLayer}
      onNotesLayerChange={(notesLayer) => onPrefs({ ...prefs, notesLayer })}
      {...(layout === "split" ? { chat: { collapsed: chatCollapsed, onToggle: () => setChatCollapsed(!chatCollapsed) } } : {})}
      navigate={enter}
      onFlow={onFlow}
      onBringIn={(text) => {
        // 帶進這一輪 (§8.3): first in the draft, never sent by itself; focus goes to the composer.
        draft.set(prependToDraft(draft.get(), text));
        toast(t("note.bringInDone"));
        if (layout === "tabs") onTab("chat");
        requestAnimationFrame(focusComposer);
      }}
      onShowAllNotes={onShowAllNotes}
    />
  );

  if (layout === "tabs") {
    return (
      <div ref={ref} hidden={tab !== "map"} className="absolute inset-0 z-10 flex flex-col bg-tg-background">
        {tab === "map" && map("sheet")}
      </div>
    );
  }
  return (
    <div ref={ref} className="flex shrink-0" style={{ width: total > 0 ? mapWidth : `${(1 - share) * 100}%` }}>
      {total > 0 && (
        <Separator
          share={share}
          total={total}
          chat={chat}
          left={() => ref.current?.parentElement?.getBoundingClientRect().left ?? 0}
          onDrag={(next) => {
            setChatCollapsed(false);
            setDragShare(next);
          }}
          onShare={(next) => {
            setChatCollapsed(false);
            setDragShare(null);
            onPrefs({ ...prefs, chatShare: next });
          }}
          onReset={() => {
            setChatCollapsed(false);
            onPrefs({ ...prefs, chatShare: null });
          }}
        />
      )}
      {map(panelPlacement(mapWidth))}
    </div>
  );
}
