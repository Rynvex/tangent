/**
 * F14 S4: the pauses in a line (two neighbouring conversation messages 30
 * minutes or more apart: an imported history keeps its real times since
 * B19) and short dates for chapters that started on another day. Small and
 * pure: the transcript draws these, so they are in the main bundle.
 */
import type { Message } from "./types";

/** Two messages this far apart show a gap (as decompose's `time_gap` and the chapters' idle gap). */
export const SESSION_GAP_MS = 30 * 60_000;

/** A gap's parts, for "2 小時 37 分" / "2 h 37 min". */
export function gapParts(gapMs: number): { days: number; hours: number; minutes: number } {
  const minutes = Math.max(0, Math.round(gapMs / 60_000));
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

/** "2 小時 37 分" (zh), "2 時間 37 分" (ja), or "2 h 37 min" (en): the two largest parts. */
export function describeGap(gapMs: number, locale: string): string {
  const { days, hours, minutes } = gapParts(gapMs);
  const zh = locale.startsWith("zh");
  const ja = locale.startsWith("ja");
  const parts = [
    days > 0 ? (zh ? `${days} 天` : ja ? `${days} 日` : `${days} d`) : "",
    hours > 0 ? (zh ? `${hours} 小時` : ja ? `${hours} 時間` : `${hours} h`) : "",
    days === 0 && (minutes > 0 || hours === 0) ? (zh || ja ? `${minutes} 分` : `${minutes} min`) : "",
  ].filter(Boolean);
  return parts.join(" ");
}

const isTalk = (message: Message) => message.kind === "chat" && (message.role === "user" || message.role === "assistant") && message.status !== "pending";

/** The messages that come 30 minutes or more after the conversation message before them, with the pause (ms). */
export function timeGaps(messages: readonly Message[], minimumMs = SESSION_GAP_MS): Map<string, number> {
  const out = new Map<string, number>();
  let previous: number | null = null;
  for (const message of messages) {
    if (!isTalk(message)) continue;
    const at = Date.parse(message.createdAt);
    if (Number.isNaN(at)) continue;
    if (previous !== null && at - previous >= minimumMs) out.set(message.id, at - previous);
    previous = at;
  }
  return out;
}

/** "08/12" for a time on another day than `now` (local), "" for today or no time. */
export function shortDateUnlessToday(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;
}

/** "14:52" (local, 24-hour). */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
