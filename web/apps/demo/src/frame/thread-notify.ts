/**
 * Thread notifications (G2, Settings → General): when a reply finishes on a
 * line that is not on screen, or while this tab is in the background, the
 * browser shows a notification (if it was allowed) and, set to `sound`, a
 * short chime plays. The part that talks to the browser loads the first time
 * a reply qualifies, so `off` (the default) costs nothing.
 */
import type { TangentEvent } from "@tangent/client";
import { useCallback, useRef } from "react";
import type { DemoPrefs } from "./prefs";

export type ThreadNotifications = DemoPrefs["threadNotifications"];

/** Whether a finished reply is news: never when off, else when the tab is away or another line is on screen. */
export function shouldNotify(mode: ThreadNotifications, tabAway: boolean, onScreen: boolean): boolean {
  return mode !== "off" && (tabAway || !onScreen);
}

export interface ThreadNotifyOptions {
  mode: ThreadNotifications;
  /** The line on screen. */
  selected: string | null;
  /** The notification's words for a line that answered (or failed). */
  describe: (lineId: string, failed: boolean) => { title: string; body: string };
  /** Pressing the notification shows that line. */
  onOpen: (lineId: string) => void;
  /** Tests pass their own; the page's notifier otherwise (loaded on first use). */
  notify?: (notice: { title: string; body: string; sound: boolean; onClick: () => void }) => void;
  /** Tests say whether the tab is in the background. */
  tabAway?: () => boolean;
}

const pageNotify: NonNullable<ThreadNotifyOptions["notify"]> = (notice) =>
  void import("./thread-notify-browser").then(
    (module) => module.notifyReply(notice),
    // The notifier did not load: the reply is still on its line, with its unread mark.
    () => undefined,
  );

const pageAway = () => document.visibilityState === "hidden" || !document.hasFocus();

/**
 * Hears the event stream (`useTangentEvents({ onEvent })`). Only a reply
 * seen pending counts, so a finished message changing later is never news;
 * a stopped reply is not announced.
 */
export function useThreadNotifications(options: ThreadNotifyOptions): (event: TangentEvent) => void {
  const pending = useRef(new Set<string>());
  const latest = useRef(options);
  latest.current = options;
  return useCallback((event: TangentEvent) => {
    if (event.type !== "message.created" && event.type !== "message.updated") return;
    const message = event.data;
    if (message.role !== "assistant" || message.kind !== "chat") return;
    if (message.status === "pending") {
      pending.current.add(message.id);
      return;
    }
    if (!pending.current.delete(message.id) || message.meta.cancelled) return;
    const { mode, selected, describe, onOpen, notify = pageNotify, tabAway = pageAway } = latest.current;
    if (!shouldNotify(mode, tabAway(), event.lineId === selected)) return;
    notify({ ...describe(event.lineId, message.status === "error"), sound: mode === "sound", onClick: () => onOpen(event.lineId) });
  }, []);
}
