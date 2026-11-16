/**
 * F14 TimeBadge and SessionTimePopover: a session's time in one of three
 * looks (the source's time with Calendar; the file's date with FileClock on
 * the warning tone; no time at all, dashed, CalendarPlus 「未定時間・設定時間」).
 * Pressing it opens the popover that sets a date and time (or goes back to
 * the file's date); the list re-sorts when it is applied (decision #4).
 */
import { IMPORT_FUTURE_SLACK_MS, sessionTimes, type TimelineSession } from "@tangent/client";
import { Button, Popover, PopoverContent, PopoverTrigger, TextField } from "@tangent/react";
import { Calendar, CalendarClock, CalendarPlus, FileClock } from "lucide-react";
import { useState } from "react";
import { cx } from "../cx";
import { useF14T } from "./f14-messages";
import { dayOf, dayRange, fromInputs, fullStamp, inputParts } from "./time-format";

const EARLIEST = Date.UTC(1970, 0, 1);

export interface SessionTimeProps {
  session: TimelineSession;
  /** S1 shows the start ("2026-08-12 14:20"), S2 the day and span ("08/12（三）14:20–18:02"). */
  variant: "start" | "span";
  touch: boolean;
  locale: string;
  /** A time the user set (ISO), or null to go back to the source's or the file's. */
  onApply: (manualTime: string | null) => void;
}

function badgeText(session: TimelineSession, variant: SessionTimeProps["variant"], locale: string, t: ReturnType<typeof useF14T>) {
  const times = sessionTimes(session);
  if (times.start === null) return t("import.noTime");
  if (times.kind === "file") return t("import.fileTime", { date: dayOf(times.start) });
  return variant === "start" ? fullStamp(times.start) : dayRange(times.start, times.end ?? times.start, locale);
}

/** The badge (a popover trigger) and the date-time popover. */
export function SessionTime({ session, variant, touch, locale, onApply }: SessionTimeProps) {
  const t = useF14T();
  const [open, setOpen] = useState(false);
  const times = sessionTimes(session);
  const text = badgeText(session, variant, locale, t);
  const Icon = times.start === null ? CalendarPlus : times.kind === "file" ? FileClock : variant === "span" ? CalendarClock : Calendar;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={t("import.badgeLabel", { time: text })}
        data-tg-time-badge={times.start === null ? "none" : times.kind}
        className={cx(
          "inline-flex shrink-0 items-center gap-1.5 rounded-tg-sm border px-2 text-tg-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tg-ring",
          touch ? "h-7 pointer-coarse:min-h-11" : "h-6 pointer-coarse:min-h-11",
          times.start === null
            ? "border-dashed border-tg-border-strong bg-tg-surface text-tg-primary-text hover:border-tg-primary"
            : times.kind === "file"
              ? "border-tg-warning bg-tg-warning-soft font-tg-mono text-tg-foreground hover:border-tg-foreground"
              : "border-tg-border bg-tg-surface-sunken font-tg-mono text-tg-foreground hover:border-tg-border-strong",
          open && "border-tg-primary",
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {text}
      </PopoverTrigger>
      <PopoverContent title={t("import.setTime", { title: session.conversation.title || t("import.untitled") })} className="w-75">
        {open && <TimeForm session={session} onDone={(value) => { setOpen(false); onApply(value); }} />}
      </PopoverContent>
    </Popover>
  );
}

/** Date, time, 用檔案時間 and 套用; the note says what it uses now and that saving re-sorts. */
function TimeForm({ session, onDone }: { session: TimelineSession; onDone: (manualTime: string | null) => void }) {
  const t = useF14T();
  const times = sessionTimes(session);
  const initial = inputParts(times.start ?? Date.now());
  const [date, setDate] = useState(initial.date);
  const [clock, setClock] = useState(initial.time);
  const [error, setError] = useState<string | null>(null);
  const fileTime = session.conversation.fileTime ? Date.parse(session.conversation.fileTime) : null;
  const now = times.start === null ? t("import.timeNowNone") : times.kind === "file" ? t("import.timeNowFile", { date: dayOf(times.start) }) : t("import.timeNowExact", { date: fullStamp(times.start) });
  const apply = () => {
    const at = fromInputs(date, clock);
    if (at === null) return setError(t("import.timeInvalid"));
    if (at < EARLIEST || at > Date.now() + IMPORT_FUTURE_SLACK_MS) return setError(t("import.timeRange"));
    onDone(new Date(at).toISOString());
  };
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <TextField type="date" label={t("import.timeDate")} value={date} onChange={(event) => setDate(event.target.value)} inputClassName="font-tg-mono" />
        <TextField type="time" label={t("import.timeClock")} value={clock} onChange={(event) => setClock(event.target.value)} error={error ?? undefined} inputClassName="font-tg-mono" />
      </div>
      <p className="m-0 text-tg-xs text-tg-muted">
        {now}
        {t("import.reorderNote")}
      </p>
      <div className="flex justify-end gap-2">
        {fileTime !== null && (
          <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
            {t("import.useFileTime")}
          </Button>
        )}
        <Button size="sm" variant="primary" type="submit">
          {t("import.timeApply")}
        </Button>
      </div>
    </form>
  );
}
