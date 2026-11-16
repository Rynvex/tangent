/**
 * Where the preferences (prefs.ts) reach the components (G2): the providers
 * around the frame, and the message box's key hint when the send keys are
 * not the usual ones. Small on purpose: this is in the page's first load.
 */
import { ConversationOptionsProvider, MarkdownOptionsProvider, ShortcutsProvider, formatKeysText, useShortcutsState, useTangent, useUiLocale } from "@tangent/react";
import type { ReactNode } from "react";
import { bindingOverrides, hour12For, type DemoPrefs } from "./prefs";

export interface PrefsProvidersProps {
  prefs: DemoPrefs;
  children: ReactNode;
}

/**
 * The reader's keys (the send shortcut and the Keybindings page), the code
 * blocks' wrapping and size, math on or off, the clock, streaming text and
 * the cards' default: one place hands them to @tangent/react.
 */
export function PrefsProviders({ prefs, children }: PrefsProvidersProps) {
  const { locale } = useTangent();
  return (
    <ShortcutsProvider target="window" bindings={bindingOverrides(prefs)}>
      <MarkdownOptionsProvider codeWrap={prefs.codeWrap} codeFontSize={prefs.codeFontSize} renderMath={prefs.renderMath}>
        <ConversationOptionsProvider hour12={hour12For(prefs, locale)} streamText={prefs.streamResponses} expandCards={prefs.expandCards}>
          {children}
        </ConversationOptionsProvider>
      </MarkdownOptionsProvider>
    </ShortcutsProvider>
  );
}

const HINT_PARTS = {
  en: { send: "{keys} to send", newline: "{keys} for a new line", branch: "{keys} to branch", join: " · " },
  "zh-TW": { send: "{keys} 送出", newline: "{keys} 換行", branch: "{keys} 開支線", join: "・" },
  ja: { send: "{keys} で送信", newline: "{keys} で改行", branch: "{keys} でブランチ", join: "・" },
} as const;

/**
 * The message box's hint in the keys as they are now, or undefined while
 * sending and the line break have their usual keys (the bundled hint says
 * those). A command whose keys are off is left out.
 */
export function useComposerHint(): string | undefined {
  const { bindings, apple } = useShortcutsState();
  const { locale } = useUiLocale();
  const send = bindings.get("composer.send") ?? null;
  const newline = bindings.get("composer.newline") ?? null;
  if (send === "Enter" && newline === "Shift+Enter") return undefined;
  const words = HINT_PARTS[locale];
  const part = (text: string, keys: string | null) => (keys ? [text.replace("{keys}", formatKeysText(keys, apple))] : []);
  return [...part(words.send, send), ...part(words.newline, newline), ...part(words.branch, bindings.get("branch.open") ?? null)].join(words.join);
}
