/**
 * The browser side of thread notifications (G2): the Notification API and a
 * chime made with Web Audio (two short sine notes, no audio file). Loaded on
 * first use by `thread-notify.ts` and by the Settings page.
 */

/** What the browser says about notifications; `unsupported` where it has none. */
export type NotifyPermission = NotificationPermission | "unsupported";

export function notificationPermission(): NotifyPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Asks the browser (it only asks after a press); resolves with what it says now. */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** The chime's two notes (Hz) and how long each rings (s). */
const CHIME_NOTES = [880, 1174.66] as const;
const CHIME_NOTE_S = 0.12;
const CHIME_GAIN = 0.06;

let audio: AudioContext | null = null;

/** A soft two-note chime; silent where Web Audio is missing or the browser has not let the page play yet. */
export function playChime(): void {
  try {
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    const context = audio;
    void context.resume();
    CHIME_NOTES.forEach((frequency, index) => {
      const start = context.currentTime + index * CHIME_NOTE_S;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(CHIME_GAIN, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + CHIME_NOTE_S * 2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + CHIME_NOTE_S * 2);
    });
  } catch {
    // No sound this time.
  }
}

export interface ReplyNotice {
  title: string;
  body: string;
  sound: boolean;
  onClick: () => void;
}

/** One notification per line of news (a newer one replaces the last), if the browser allows; the chime when asked for. */
export function notifyReply({ title, body, sound, onClick }: ReplyNotice): void {
  if (notificationPermission() === "granted") {
    try {
      // The chime is ours, so the system's own sound stays off.
      const notification = new Notification(title, { body, tag: "tangent-reply", silent: true });
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker: the chime still plays.
    }
  }
  if (sound) playChime();
}
