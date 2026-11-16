/**
 * Local-time wording of the F14 dialog: "2026-08-12 14:20" (S1),
 * "08/12（三）14:20–18:02" (S2), "08/18" (a file date), "08/12–08/20"
 * (the summary's range). Pure; the device's time zone.
 */
const pad = (n: number) => String(n).padStart(2, "0");
const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEK_JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const dayOf = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
};
export const clockOf = (at: number) => {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fullStamp = (at: number) => `${new Date(at).getFullYear()}-${dayOf(at).replace("/", "-")} ${clockOf(at)}`;
/** "2026/08/12" for the selection summary. */
export const yearDay = (at: number) => `${new Date(at).getFullYear()}/${dayOf(at)}`;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "08/12（三）14:20–18:02" (zh/ja) or "08/12 (Wed) 14:20–18:02" (en); another day's end carries its date. */
export function dayRange(start: number, end: number, locale: string): string {
  const zh = locale.startsWith("zh");
  const ja = locale.startsWith("ja");
  const week = (ja ? WEEK_JA : zh ? WEEK_ZH : WEEK_EN)[new Date(start).getDay()];
  const head = zh || ja ? `${dayOf(start)}（${week}）${clockOf(start)}` : `${dayOf(start)} (${week}) ${clockOf(start)}`;
  if (end <= start) return head;
  return sameDay(start, end) ? `${head}–${clockOf(end)}` : `${head} – ${dayOf(end)} ${clockOf(end)}`;
}

/** "08/12–08/20", or one day. */
export function dayToDay(from: number, to: number): string {
  return sameDay(from, to) ? dayOf(from) : `${dayOf(from)}–${dayOf(to)}`;
}

/** The value of `<input type="date">` and `<input type="time">` for a time. */
export function inputParts(at: number): { date: string; time: string } {
  const d = new Date(at);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: clockOf(at) };
}

/** A local date and time from the two inputs; null when they are not a real moment. */
export function fromInputs(date: string, time: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!day || !clock) return null;
  const [, y, mo, d] = day.map(Number) as [number, number, number, number];
  const at = new Date(y, mo - 1, d, Number(clock[1]), Number(clock[2]));
  return Number.isNaN(at.getTime()) || at.getDate() !== d ? null : at.getTime();
}
