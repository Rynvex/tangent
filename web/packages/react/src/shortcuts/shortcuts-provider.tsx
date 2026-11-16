import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Kbd } from "../components/display";
import { cx } from "../lib/cx";
import { useShallowStable } from "../lib/use-shallow-stable";
import { useTangentRootElement } from "../root/tangent-root";
import { DEFAULT_COMMANDS, PALETTE_COMMAND_ID, resolveBindings, type BindingOverrides, type BindingWarn, type CommandDef } from "./commands";
import { formatKeys, formatKeysText, isApplePlatform, isComposing, matchesKeys, parseKeys, type KeyCombo, type KeyEventLike } from "./keys";
import { createShortcutRegistry, ESCAPE_PRIORITY, type Handler, type HandlerRef, type ShortcutRegistry } from "./registry";

interface ShortcutsState {
  commands: readonly CommandDef[];
  bindings: ReadonlyMap<string, string | null>;
  apple: boolean;
  paletteOpen: boolean;
}

/** Stable for the provider's lifetime: hooks that only register never re-render on state changes. */
interface ShortcutsActions {
  registry: ShortcutRegistry;
  run: (id: string) => boolean;
  setPaletteOpen: (open: boolean) => void;
}

const StateContext = createContext<ShortcutsState | null>(null);
const ActionsContext = createContext<ShortcutsActions | null>(null);

const NO_EXTRA_COMMANDS: readonly CommandDef[] = [];
const NO_OVERRIDES: BindingOverrides = {};

/** Popups that own their keys: inside them only palette-safe commands fire, and Esc is theirs. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"]';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select");
}

function inOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) !== null;
}

const subscribeNothing = () => () => {};

/** ⌘ on Apple, Ctrl elsewhere; `false` on the server, the real answer after hydration. */
function useApple(platform: "apple" | "other" | undefined): boolean {
  const detected = useSyncExternalStore(subscribeNothing, () => isApplePlatform(), () => false);
  return platform ? platform === "apple" : detected;
}

export interface ShortcutsProviderProps {
  /** The host's key changes: `{ "branch.open": "Mod+Shift+B", "sidebar.toggle": null }`. Inline objects are fine. */
  bindings?: BindingOverrides;
  /** Extra commands next to the defaults (later steps add theirs here). */
  commands?: readonly CommandDef[];
  /** Overrides platform detection (tests, or a host that knows better). */
  platform?: "apple" | "other";
  /**
   * Where keys are heard. `root` (default): only while focus is inside the
   * enclosing TangentRoot, so an embedded Tangent never reacts to the host's
   * keys and two instances never both fire. `window`: anywhere on the page,
   * for a full-page app (the demo).
   */
  target?: "root" | "window";
  /** Configuration problems (bad bindings, unknown ids, clashes); console.warn by default. */
  onWarning?: BindingWarn;
  children: ReactNode;
}

const consoleWarn: BindingWarn = (message) => console.warn(message);

interface KeyContext {
  combos: readonly { command: CommandDef; combo: KeyCombo }[];
  apple: boolean;
  registry: ShortcutRegistry;
  run: (id: string) => boolean;
}

/** The single key handler: Escape layers first, then the matching global command. */
function handleKey(event: KeyboardEvent, { combos, apple, registry, run }: KeyContext): void {
  if (event.defaultPrevented || isComposing(event)) return;
  const overlay = inOverlay(event.target);
  if (event.key === "Escape" && !overlay && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const layer = registry.topEscapeLayer();
    if (layer) {
      event.preventDefault();
      layer.onEscape.current();
      return;
    }
  }
  for (const { command, combo } of combos) {
    if (!matchesKeys(event, combo, apple)) continue;
    if (!combo.mod && !combo.alt && isEditable(event.target)) continue;
    if (!command.inOverlays && overlay) continue;
    if (command.id !== PALETTE_COMMAND_ID && !registry.handler(command.id)) continue;
    event.preventDefault();
    // A held key repeats keydown; toggles must not flicker.
    if (!event.repeat) run(command.id);
    return;
  }
}

/**
 * The keyboard-shortcut registry (shortcuts.md). Components register what a
 * command does with `useCommand`; one listener (on the TangentRoot, or the
 * window when `target="window"`) runs the matching command. It never fires
 * during IME composition, for a repeated key, or for an event that was
 * already handled. Keys without ⌘/Ctrl/Alt do not fire from text fields, and
 * inside dialogs or menus only palette-safe commands do. It is also the one
 * owner of Esc: open panels (`useEscapeLayer`) close before `nav.back` runs.
 */
export function ShortcutsProvider({ bindings: rawOverrides = NO_OVERRIDES, commands: rawExtra = NO_EXTRA_COMMANDS, platform, target = "root", onWarning = consoleWarn, children }: ShortcutsProviderProps) {
  const overrides = useShallowStable(rawOverrides);
  const extra = useShallowStable(rawExtra);
  const warn = useRef(onWarning);
  useLayoutEffect(() => {
    warn.current = onWarning;
  });
  const commands = useMemo(() => [...DEFAULT_COMMANDS, ...extra], [extra]);
  const bindings = useMemo(() => resolveBindings(commands, overrides, (message) => warn.current(message)), [commands, overrides]);
  const apple = useApple(platform);
  const [registry] = useState(() => createShortcutRegistry([PALETTE_COMMAND_ID]));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const root = useTangentRootElement();

  const run = useCallback(
    (id: string) => {
      if (id === PALETTE_COMMAND_ID) {
        setPaletteOpen((open) => !open);
        return true;
      }
      const handler = registry.handler(id);
      handler?.current();
      return handler !== undefined;
    },
    [registry],
  );

  const combos = useMemo(
    () =>
      commands.flatMap((command) => {
        const keys = bindings.get(command.id);
        return command.scope === "global" && keys ? [{ command, combo: parseKeys(keys) }] : [];
      }),
    [commands, bindings],
  );

  const element: HTMLElement | Window | null = target === "window" ? (typeof window === "undefined" ? null : window) : root;
  useEffect(() => {
    if (!element) return undefined;
    const onKeyDown = (event: Event) => handleKey(event as KeyboardEvent, { combos, apple, registry, run });
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [element, combos, apple, registry, run]);

  const state = useMemo<ShortcutsState>(() => ({ commands, bindings, apple, paletteOpen }), [commands, bindings, apple, paletteOpen]);
  const actions = useMemo<ShortcutsActions>(() => ({ registry, run, setPaletteOpen }), [registry, run]);
  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </ActionsContext.Provider>
  );
}

const MISSING = "Shortcut hooks must be used inside <ShortcutsProvider>.";

export function useShortcutsState(): ShortcutsState {
  const value = useContext(StateContext);
  if (!value) throw new Error(MISSING);
  return value;
}

export function useShortcutsActions(): ShortcutsActions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error(MISSING);
  return value;
}

/** Ids with a registered handler (re-renders only when that list changes). */
export function useAvailableCommands(): ReadonlySet<string> {
  const { registry } = useShortcutsActions();
  return useSyncExternalStore(registry.subscribe, registry.available, registry.available);
}

/** The latest value in a ref, updated after render (never during it). */
function useLatest(handler: Handler): HandlerRef {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  return ref;
}

/**
 * Registers what a command does while the component is mounted (and
 * `enabled`). The latest handler always runs, so an inline function is fine.
 * A second registration of the same id wins until it unmounts.
 */
export function useCommand(id: string, handler: Handler, enabled = true): void {
  const { registry } = useShortcutsActions();
  const ref = useLatest(handler);
  useEffect(() => (enabled ? registry.register(id, ref) : undefined), [id, enabled, registry, ref]);
}

/** `useCommand` for a part that also renders without a ShortcutsProvider (an embed, a test): then nothing is registered. */
export function useOptionalCommand(id: string, handler: Handler, enabled = true): void {
  const registry = useContext(ActionsContext)?.registry;
  const ref = useLatest(handler);
  useEffect(() => (enabled && registry ? registry.register(id, ref) : undefined), [id, enabled, registry, ref]);
}

/**
 * Takes Esc while `active` (an open overlay or panel), above `nav.back`.
 * Returns false outside a ShortcutsProvider, so the caller can handle Esc itself.
 */
export function useEscapeLayer(active: boolean, onEscape: Handler, priority: number = ESCAPE_PRIORITY.panel): boolean {
  const actions = useContext(ActionsContext);
  const ref = useLatest(onEscape);
  useEffect(() => (active && actions ? actions.registry.addEscapeLayer({ priority, onEscape: ref }) : undefined), [active, actions, priority, ref]);
  return actions !== null;
}

/** For `composer`-scope commands: a predicate the component's own onKeyDown calls. */
export function useShortcutMatcher(): (event: KeyEventLike, id: string) => boolean {
  const { bindings, apple } = useShortcutsState();
  return useCallback(
    (event: KeyEventLike, id: string) => {
      const keys = bindings.get(id);
      return keys ? matchesKeys(event, parseKeys(keys), apple) : false;
    },
    [bindings, apple],
  );
}

/**
 * Like `useShortcutMatcher`, but null outside a `ShortcutsProvider`, so a
 * component a host renders without one (the composer) can fall back to its
 * default keys.
 */
export function useOptionalShortcutMatcher(): ((event: KeyEventLike, id: string) => boolean) | null {
  const state = useContext(StateContext);
  const bindings = state?.bindings;
  const apple = state?.apple ?? false;
  return useMemo(
    () =>
      bindings
        ? (event: KeyEventLike, id: string) => {
            const keys = bindings.get(id);
            return keys ? matchesKeys(event, parseKeys(keys), apple) : false;
          }
        : null,
    [bindings, apple],
  );
}

/** `useShortcutText` that answers null outside a `ShortcutsProvider`. */
export function useOptionalShortcutText(id: string): string | null {
  const state = useContext(StateContext);
  const keys = state?.bindings.get(id);
  return keys ? formatKeysText(keys, state?.apple ?? false) : null;
}

/** The key labels of a command's current binding, or null when it has none. */
export function useShortcutLabel(id: string): string[] | null {
  const { bindings, apple } = useShortcutsState();
  const keys = bindings.get(id);
  return keys ? formatKeys(keys, apple) : null;
}

/** A command's binding as one string ("⌘B", "Ctrl+B"), or null when it has none. */
export function useShortcutText(id: string): string | null {
  const { bindings, apple } = useShortcutsState();
  const keys = bindings.get(id);
  return keys ? formatKeysText(keys, apple) : null;
}

export interface ShortcutKeysProps {
  command: string;
  /** Hide on touch screens (review §2 #3). */
  hint?: boolean;
  className?: string;
}

/** A command's keys as <Kbd>s; renders nothing when the host turned the keys off. */
export function ShortcutKeys({ command, hint = false, className }: ShortcutKeysProps) {
  const labels = useShortcutLabel(command);
  if (!labels) return null;
  return (
    <span className={cx("inline-flex items-center gap-0.5", hint && "tg-kbd-hint", className)}>
      {labels.map((label) => (
        <Kbd key={label}>{label}</Kbd>
      ))}
    </span>
  );
}
