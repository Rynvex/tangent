import type { ClientMessageKey } from "@tangent/client";
import type { en } from "./en";
import type { enSettings } from "./en.settings";
import type { P1MessageKey } from "./p1-messages";
import type { P2MessageKey } from "./p2-messages";

/** Every message key the bundled dictionaries define. */
export type MessageKey = keyof typeof en | keyof typeof enSettings;

/** A full dictionary. */
export type Messages = Record<MessageKey, string>;

/**
 * What a host passes as `TangentProvider messages`: its own wording for any
 * bundled key, plus `error.<code>` entries for its own error codes.
 */
export type HostMessages = Partial<Messages> & Partial<Readonly<Record<P1MessageKey | P2MessageKey, string>>> & { readonly [key: `error.${string}`]: string };

/** Locales with a bundled dictionary. */
export type Locale = "en" | "zh-TW" | "ja";

export type TranslateParams = Readonly<Record<string, string | number>>;

export type Translate = (key: MessageKey, params?: TranslateParams) => string;

/** Compile-time guard: the bundled dictionaries cover every key the client logic produces. */
type MissingClientKeys = Exclude<ClientMessageKey, MessageKey>;
export const CLIENT_KEYS_COVERED: [MissingClientKeys] extends [never] ? true : MissingClientKeys = true;
