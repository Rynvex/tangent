/**
 * How a chapter reads on screen (its title and time range, and the lookup by
 * first message), apart from the chapters API's normalizers so the
 * conversation's main bundle carries only these (F20a). `chapters.ts`
 * re-exports them.
 */
import type { Chapter } from "./types";

function formatStamp(iso: string, locale: string, withDate: boolean, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = withDate
    ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }
    : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** The calendar day of an instant in the display time zone (the viewer's when `timeZone` is unset). */
function displayDay(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(date);
}

/** The heading of a chapter: its name or topic, or the local date and time when it has neither. */
export function chapterTitle(chapter: Chapter, locale: string, timeZone?: string): string {
  if (chapter.titleSource !== "time" && chapter.title !== "") return chapter.title;
  return formatStamp(chapter.startAt, locale, true, timeZone) || chapter.title;
}

/**
 * "start - end" of a chapter in the display time zone; the end carries a date
 * when it falls on another day there (not in UTC).
 */
export function chapterRange(chapter: Chapter, locale: string, timeZone?: string): string {
  const start = formatStamp(chapter.startAt, locale, true, timeZone);
  const sameDay = displayDay(chapter.startAt, timeZone) === displayDay(chapter.endAt, timeZone);
  const end = formatStamp(chapter.endAt, locale, !sameDay, timeZone);
  if (start === "") return end;
  return end === "" || end === start ? start : `${start} - ${end}`;
}

/** The chapter whose first message is `messageId`, for dividers in the transcript. */
export function chaptersByStart(chapters: readonly Chapter[]): Map<string, Chapter> {
  return new Map(chapters.map((chapter) => [chapter.startMessageId, chapter]));
}
