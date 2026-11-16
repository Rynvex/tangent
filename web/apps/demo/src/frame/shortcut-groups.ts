/**
 * The shortcut list's model (F8 S4), pure: which command goes in which
 * group, which keys Firefox keeps for itself, and whether the list is worth
 * offering at all (decision #12: not on a touch screen with no keyboard).
 */
import { canonicalKeys, type CommandDef, type MessageKey } from "@tangent/react";
import type { F8ShellMessageKey } from "./f8-shell-messages";

export const SHORTCUT_GROUPS = ["nav", "branch", "notes", "focus"] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export const GROUP_TITLE_KEYS: Record<ShortcutGroup, F8ShellMessageKey> = {
  nav: "shortcuts.groupNav",
  branch: "shortcuts.groupBranch",
  notes: "shortcuts.groupNotes",
  focus: "shortcuts.groupFocus",
};

/** Commands by group; anything else (a host's own command) is navigation. */
const GROUP_OF: Readonly<Record<string, ShortcutGroup>> = {
  "palette.open": "nav",
  "search.inTree": "nav",
  "nav.mainLine": "nav",
  "nav.back": "nav",
  "sidebar.toggle": "nav",
  "structure.toggleView": "nav",
  "turn.preview": "nav",
  "shortcuts.help": "nav",
  "composer.send": "nav",
  "composer.newline": "nav",
  "branch.open": "branch",
  "branch.bringBack": "branch",
  "composer.park": "notes",
  "notes.add": "notes",
  "focus.toggle": "focus",
};

/** The group a command is listed under (a host's own command is navigation). */
export const commandGroup = (id: string): ShortcutGroup => GROUP_OF[id] ?? "nav";

/** Keys Firefox takes before the page sees them (packages/react/README.md, browser-reserved combinations). */
const FIREFOX_RESERVED = new Set(["mod+shift+p", "mod+shift+m", "mod+shift+s"].map(canonicalKeys));

export function isFirefoxReserved(binding: string): boolean {
  try {
    return FIREFOX_RESERVED.has(canonicalKeys(binding));
  } catch {
    return false;
  }
}

export interface ShortcutRow {
  id: string;
  titleKey: MessageKey;
  /** The binding as set now (a host's own keys included). */
  keys: string;
  firefox: boolean;
}

export interface ShortcutSection {
  group: ShortcutGroup;
  rows: ShortcutRow[];
}

/**
 * Every command that has keys now, grouped in SHORTCUT_GROUPS order and in
 * the commands' own order inside a group; a command whose keys are off (or
 * that only runs from the palette) is not listed; empty groups are left out.
 */
export function shortcutSections(commands: readonly CommandDef[], bindings: ReadonlyMap<string, string | null>): ShortcutSection[] {
  const rows = commands.flatMap((command) => {
    const keys = bindings.get(command.id);
    return keys ? [{ group: GROUP_OF[command.id] ?? "nav", row: { id: command.id, titleKey: command.titleKey, keys, firefox: isFirefoxReserved(keys) } }] : [];
  });
  return SHORTCUT_GROUPS.map((group) => ({ group, rows: rows.filter((item) => item.group === group).map((item) => item.row) })).filter((section) => section.rows.length > 0);
}

export { isPhysicalKey, resetKeyboardSeen, shortcutsHelpAvailable, useHasKeyboard, type KeyboardWindow } from "./has-keyboard";
