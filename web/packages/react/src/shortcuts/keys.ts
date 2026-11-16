/**
 * Key bindings as strings such as "Mod+Shift+S", "Mod+[", "Escape" or
 * "Shift+Enter". `Mod` is ⌘ on Apple platforms and Ctrl elsewhere
 * (shortcuts.md). Pure functions; the provider wires them to events.
 */

export interface KeyCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Lower-case `KeyboardEvent.key` value: "s", "[", ".", "enter", "escape". */
  key: string;
}

/** The parts of a KeyboardEvent the matcher reads (DOM and React events both fit). */
export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** React's synthetic events keep `isComposing` here. */
  nativeEvent?: { isComposing?: boolean };
}

const MODIFIERS = new Set(["mod", "shift", "alt"]);

/** Parses "Mod+Shift+S"; throws on an empty key or an unknown modifier so typos in host config surface early. */
export function parseKeys(binding: string): KeyCombo {
  const parts = binding.split("+").map((part) => part.trim());
  // "Mod++" means the "+" key.
  const key = binding.endsWith("++") ? "+" : (parts.pop() ?? "");
  if (binding.endsWith("++")) parts.splice(-2, 2);
  if (!key) throw new Error(`invalid key binding: "${binding}"`);
  const modifiers = parts.map((part) => part.toLowerCase());
  for (const modifier of modifiers) {
    if (!MODIFIERS.has(modifier)) throw new Error(`unknown modifier "${modifier}" in "${binding}"`);
  }
  return { mod: modifiers.includes("mod"), shift: modifiers.includes("shift"), alt: modifiers.includes("alt"), key: key.toLowerCase() };
}

/** A canonical form for comparing bindings ("mod+shift+s"). */
export function canonicalKeys(binding: string): string {
  const combo = parseKeys(binding);
  return [combo.mod && "mod", combo.shift && "shift", combo.alt && "alt", combo.key].filter(Boolean).join("+");
}

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** True on macOS and iOS, where Mod is ⌘. */
export function isApplePlatform(nav: NavigatorLike | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** `event.code` → the US-layout punctuation key, for when Shift or Alt changed `key` ("Mod+Shift+[" gives "{"). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Period: ".",
  Comma: ",",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

function codeKey(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return CODE_KEYS[code];
}

/** A single character outside printable ASCII: the key of a non-Latin layout (Cyrillic, Zhuyin…) or a macOS Alt symbol. */
function isNonLatinChar(key: string): boolean {
  return key.length === 1 && (key.charCodeAt(0) < 0x20 || key.charCodeAt(0) > 0x7e);
}

/** An input method is composing (Chinese, Japanese…): its Enter / Esc belong to the IME, never to a shortcut. */
export function isComposing(event: KeyEventLike): boolean {
  // keyCode 229 is what browsers report for keys the IME is processing (Safari ends composition before keydown).
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229;
}

/** True when the event is exactly this combination (extra modifiers do not match). */
export function matchesKeys(event: KeyEventLike, combo: KeyCombo, apple: boolean): boolean {
  if (isComposing(event)) return false;
  const mod = apple ? event.metaKey : event.ctrlKey;
  const otherMod = apple ? event.ctrlKey : event.metaKey;
  if (mod !== combo.mod || otherMod || event.shiftKey !== combo.shift || event.altKey !== combo.alt) return false;
  const key = event.key.toLowerCase();
  if (key === combo.key) return true;
  // Letters and digits follow the layout (`key`): on Dvorak, Ctrl+X must stay Ctrl+X even though it sits where QWERTY has B.
  // The physical key (`code`) only stands in when `key` cannot name it: a non-Latin layout, or punctuation that Shift / Alt changed.
  const physical = codeKey(event.code);
  if (physical !== combo.key) return false;
  if (isNonLatinChar(event.key)) return true;
  return !/^[a-z0-9]$/.test(combo.key) && (event.shiftKey || event.altKey);
}

const APPLE_LABELS: Readonly<Record<string, string>> = { mod: "⌘", shift: "⇧", alt: "⌥" };
const OTHER_LABELS: Readonly<Record<string, string>> = { mod: "Ctrl", shift: "Shift", alt: "Alt" };
const KEY_LABELS: Readonly<Record<string, string>> = { escape: "Esc", enter: "Enter", arrowup: "↑", arrowdown: "↓", " ": "Space" };

/** The keys to show for a binding: ["⌘", "⇧", "S"] on Apple, ["Ctrl", "Shift", "S"] elsewhere. */
export function formatKeys(binding: string, apple: boolean): string[] {
  const combo = parseKeys(binding);
  const labels = apple ? APPLE_LABELS : OTHER_LABELS;
  const modifiers = (["mod", "shift", "alt"] as const).filter((name) => combo[name]).map((name) => labels[name]!);
  const key = KEY_LABELS[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key[0]!.toUpperCase() + combo.key.slice(1));
  return [...modifiers, key];
}

/** A binding as one string: "⌘⇧S" on Apple (as macOS menus write it), "Ctrl+Shift+S" elsewhere. */
export function formatKeysText(binding: string, apple: boolean): string {
  return formatKeys(binding, apple).join(apple ? "" : "+");
}
