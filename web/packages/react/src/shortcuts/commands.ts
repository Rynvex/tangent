import type { MessageKey } from "../i18n";
import { canonicalKeys } from "./keys";

/**
 * Where a command's keys are listened for: `global` on the window (only
 * while a handler is registered), `composer` by the composer's own key
 * handler (`useShortcutMatcher`).
 */
export type CommandScope = "global" | "composer";

export interface CommandDef {
  id: string;
  titleKey: MessageKey;
  /** Default binding; null for commands that only run from the palette. */
  keys: string | null;
  scope: CommandScope;
  /** Listed in the command palette (when a handler is registered). */
  palette: boolean;
  /** Also fires while focus is inside a dialog, menu or listbox. */
  inOverlays?: boolean;
}

/** The command palette itself; its keys can be rebound but never removed (shortcuts.md). */
export const PALETTE_COMMAND_ID = "palette.open";

/** The commands of shortcuts.md (F0, plus F2's ⌘Enter "end and bring back" in a branch and F3's ⌘⇧N "save to notes"). Their actions are wired by the app. */
export const DEFAULT_COMMANDS: readonly CommandDef[] = [
  { id: PALETTE_COMMAND_ID, titleKey: "command.palette.open", keys: "Mod+K", scope: "global", palette: false, inOverlays: true },
  { id: "branch.open", titleKey: "command.branch.open", keys: "Mod+B", scope: "global", palette: true },
  { id: "composer.park", titleKey: "command.composer.park", keys: "Mod+Shift+S", scope: "global", palette: true },
  { id: "notes.add", titleKey: "command.notes.add", keys: "Mod+Shift+N", scope: "global", palette: true },
  { id: "nav.mainLine", titleKey: "command.nav.mainLine", keys: "Mod+[", scope: "global", palette: true },
  { id: "branch.bringBack", titleKey: "command.branch.bringBack", keys: "Mod+Enter", scope: "global", palette: true },
  { id: "nav.back", titleKey: "command.nav.back", keys: "Escape", scope: "global", palette: false },
  { id: "sidebar.toggle", titleKey: "command.sidebar.toggle", keys: "Mod+.", scope: "global", palette: true },
  { id: "structure.toggleView", titleKey: "command.structure.toggleView", keys: "Mod+Shift+M", scope: "global", palette: true },
  { id: "turn.preview", titleKey: "command.turn.preview", keys: "Mod+Shift+P", scope: "global", palette: true },
  // Focus mode (FOCUS_MODE.md §10); hosts rebind it where a browser takes ⌘⇧F (⌘\ is the fallback).
  { id: "focus.toggle", titleKey: "command.focus.toggle", keys: "Mod+Shift+F", scope: "global", palette: true },
  // F8: in-tree search (a second ⌘F inside the open bar goes to the browser), the shortcut list and palette-only commands.
  { id: "search.inTree", titleKey: "command.search.inTree", keys: "Mod+F", scope: "global", palette: true },
  { id: "shortcuts.help", titleKey: "command.shortcuts.help", keys: "Shift+?", scope: "global", palette: true },
  { id: "conversation.new", titleKey: "command.conversation.new", keys: null, scope: "global", palette: true },
  { id: "nav.toBranch", titleKey: "command.nav.toBranch", keys: null, scope: "global", palette: true },
  { id: "export.open", titleKey: "command.export.open", keys: null, scope: "global", palette: true },
  { id: "diverge.models", titleKey: "command.diverge.models", keys: null, scope: "global", palette: true },
  { id: "review.open", titleKey: "command.review.open", keys: null, scope: "global", palette: true },
  { id: "memory.open", titleKey: "command.memory.open", keys: null, scope: "global", palette: true },
  // F19 §4: 新增關聯 is here while the outline has no relation to list (its section is not shown then).
  { id: "relation.add", titleKey: "command.relation.add", keys: null, scope: "global", palette: true },
  { id: "theme.toggle", titleKey: "command.theme.toggle", keys: null, scope: "global", palette: true },
  { id: "composer.send", titleKey: "command.composer.send", keys: "Enter", scope: "composer", palette: false },
  { id: "composer.newline", titleKey: "command.composer.newline", keys: "Shift+Enter", scope: "composer", palette: false },
];

/** A host's changes: a new binding, or null to turn a command's keys off. */
export type BindingOverrides = Readonly<Record<string, string | null>>;

/** Receives configuration problems (bad binding strings, unknown ids, clashing overrides). */
export type BindingWarn = (message: string) => void;

/** The canonical form, or null (and a warning) when the string is not a valid binding. */
function canonical(binding: string, id: string, warn: BindingWarn): string | null {
  try {
    return canonicalKeys(binding);
  } catch (error) {
    warn(`[tangent] ignoring the key binding "${binding}" of "${id}": ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Each command's effective binding. Rules (shortcuts.md):
 * - a host override wins over the default, and a default whose keys an
 *   override now uses loses them (衝突時以宿主為準);
 * - the command palette always keeps keys: it can be rebound, never removed,
 *   and an override of another command that would take its keys is dropped;
 * - two overrides with the same keys: the first keeps them;
 * - an invalid binding string or an unknown id is reported and skipped,
 *   never thrown (a host typo must not break rendering).
 */
export function resolveBindings(commands: readonly CommandDef[], overrides: BindingOverrides = {}, warn: BindingWarn = () => {}): ReadonlyMap<string, string | null> {
  const known = new Map(commands.map((command) => [command.id, command]));
  for (const id of Object.keys(overrides)) if (!known.has(id)) warn(`[tangent] unknown command "${id}" in the key bindings`);

  const palette = known.get(PALETTE_COMMAND_ID);
  const paletteOverride = overrides[PALETTE_COMMAND_ID];
  const paletteKeys = typeof paletteOverride === "string" && canonical(paletteOverride, PALETTE_COMMAND_ID, warn) ? paletteOverride : (palette?.keys ?? null);
  const taken = new Map<string, string>();
  if (paletteKeys) taken.set(canonicalKeys(paletteKeys), PALETTE_COMMAND_ID);

  const result = new Map<string, string | null>();
  if (palette) result.set(PALETTE_COMMAND_ID, paletteKeys);
  for (const [id, keys] of Object.entries(overrides)) {
    if (!known.has(id) || id === PALETTE_COMMAND_ID) continue;
    if (keys === null) {
      result.set(id, null);
      continue;
    }
    const form = canonical(keys, id, warn);
    if (form === null) continue;
    const owner = taken.get(form);
    if (owner) {
      warn(`[tangent] "${id}" cannot use ${keys}: "${owner}" already has it`);
      result.set(id, null);
      continue;
    }
    taken.set(form, id);
    result.set(id, keys);
  }
  for (const command of commands) {
    if (result.has(command.id)) continue;
    const form = command.keys === null ? null : canonical(command.keys, command.id, warn);
    result.set(command.id, form !== null && !taken.has(form) ? command.keys : null);
  }
  return result;
}
