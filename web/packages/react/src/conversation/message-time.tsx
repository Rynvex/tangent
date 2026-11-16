import { clockTime, shortDateUnlessToday } from "@tangent/client";
import { useUiLocale, useUiT } from "../provider";
import { useConversationOptions } from "./view-options";

/** "2:52 PM" in the locale's own words; "" for an invalid time. */
function clockTime12(iso: string, locale: string): string {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}

/**
 * F14 S4b: when a message was written, after its label ("你・#3・14:52",
 * "08/12 14:52" for another day). The separator is read too, so a screen
 * reader does not run "#3" and "14:52" together. Nothing without a valid time.
 * With `hour12` (ConversationOptionsProvider) the clock reads "2:52 PM".
 */
export function MessageTime({ at }: { at: string }) {
  const t = useUiT();
  const { locale } = useUiLocale();
  const { hour12 } = useConversationOptions();
  const clock = hour12 ? clockTime12(at, locale) : clockTime(at);
  if (!clock) return null;
  const day = shortDateUnlessToday(at);
  return (
    <time dateTime={at} data-tg-message-time="" className="font-tg-mono">
      {t("message.timeSeparator")}
      {day ? `${day} ${clock}` : clock}
    </time>
  );
}
