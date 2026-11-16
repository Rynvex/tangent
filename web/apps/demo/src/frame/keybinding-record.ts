/**
 * Recording a key binding (G2, Settings → Keybindings), pure: a key press
 * becomes a binding string ("Mod+Shift+B") the shortcut registry reads, and
 * a binding is checked against the keys the other commands have now.
 */
import { canonicalKeys, type CommandDef } from "@tangent/react";

/** The parts of a KeyboardEvent read here (DOM and React events both fit). */
export interface RecordedKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type RecordResult =
  /** Only a modifier so far: keep listening. */
  | { kind: "pending" }
  | { kind: "cancel" }
  /** A key that cannot be a binding (a bare letter, Tab, the other platform's modifier). */
  | { kind: "invalid" }
  | { kind: "binding"; keys: string };

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS", "Dead", "Process"]);

/** The key's name for a binding: the letter or digit of the physical key when Alt (or a non-Latin layout) changed `key`. */
function keyName(event: RecordedKeyEvent): string | null {
  const { key, code } = event;
  if (key.length !== 1) return key === "Tab" || key === "Unidentified" ? null : key;
  if (key === " " || key === "+") return null;
  const ascii = key.charCodeAt(0) > 0x20 && key.charCodeAt(0) < 0x7f;
  if (ascii) return key.toUpperCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return null;
}

/**
 * What a key press means while recording. Esc alone cancels. A printable key
 * needs ⌘/Ctrl or Alt (Shift is enough for punctuation: "Shift+?"), so a
 * binding never swallows plain typing; `bareKeys` lets the message box's own
 * commands take Enter by itself. Ctrl on Apple and ⌘ / Win elsewhere cannot
 * be written as a binding.
 */
export function recordKey(event: RecordedKeyEvent, apple: boolean, bareKeys = false): RecordResult {
  if (MODIFIER_KEYS.has(event.key)) return { kind: "pending" };
  const mod = apple ? event.metaKey : event.ctrlKey;
  const otherMod = apple ? event.ctrlKey : event.metaKey;
  if (event.key === "Escape" && !mod && !otherMod && !event.shiftKey && !event.altKey) return { kind: "cancel" };
  const name = keyName(event);
  if (otherMod || name === null) return { kind: "invalid" };
  const printable = name.length === 1;
  const letterOrDigit = /^[A-Z0-9]$/.test(name);
  const strong = mod || event.altKey;
  if (!strong && printable && (letterOrDigit || !event.shiftKey)) return { kind: "invalid" };
  if (!strong && !printable && !bareKeys && (name === "Enter" || name === "Backspace" || name === "Delete" || name.startsWith("Arrow"))) return { kind: "invalid" };
  const keys = [mod && "Mod", event.shiftKey && "Shift", event.altKey && "Alt", name].filter(Boolean).join("+");
  try {
    canonicalKeys(keys);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "binding", keys };
}

function sameKeys(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return canonicalKeys(a) === canonicalKeys(b);
  } catch {
    return false;
  }
}

/** The other command that has `keys` now, if any. */
export function conflictOf(keys: string, commandId: string, commands: readonly CommandDef[], bindings: ReadonlyMap<string, string | null>): CommandDef | null {
  return commands.find((command) => command.id !== commandId && sameKeys(bindings.get(command.id), keys)) ?? null;
}

/**
 * The reader's overrides with `commandId` set to `keys`. Keys equal to the
 * command's default are no override at all (the entry goes), so the list
 * holds only real changes; null (reset) removes the entry.
 */
export function withBinding(overrides: Readonly<Record<string, string | null>>, command: CommandDef, keys: string | null): Record<string, string | null> {
  const { [command.id]: _, ...rest } = overrides;
  return keys === null || sameKeys(keys, command.keys) ? rest : { ...rest, [command.id]: keys };
}
