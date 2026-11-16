import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Kbd } from "../components/display";
import type { Translate } from "../i18n";
import { cx } from "../lib/cx";
import { useUiT } from "../provider";
import { useTangentPortalContainer } from "../root/tangent-root";
import type { CommandDef } from "./commands";
import { formatKeysText, isComposing } from "./keys";
import { useAvailableCommands, useShortcutsActions, useShortcutsState } from "./shortcuts-provider";

export interface PaletteEntry {
  id: string;
  title: string;
  /** The binding as display text ("⌘B", "Ctrl+B"). */
  keys: string | null;
}

/** Runnable palette commands whose title (or id) contains every word of the query, in registry order. */
export function filterPaletteEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const text = `${entry.title} ${entry.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

function entriesFor(commands: readonly CommandDef[], available: ReadonlySet<string>, bindings: ReadonlyMap<string, string | null>, apple: boolean, t: Translate): PaletteEntry[] {
  return commands
    .filter((command) => command.palette && available.has(command.id))
    .map((command) => {
      const keys = bindings.get(command.id);
      return { id: command.id, title: t(command.titleKey), keys: keys ? formatKeysText(keys, apple) : null };
    });
}

/**
 * ⌘K / Ctrl+K: search the registered commands and run one. A combobox over a
 * listbox (aria-activedescendant); ↑ ↓ move, Enter runs, Esc closes. Always
 * available, whatever the host did to the other shortcuts.
 */
export function CommandPalette() {
  const t = useUiT();
  const container = useTangentPortalContainer();
  const { commands, bindings, apple, paletteOpen } = useShortcutsState();
  const { setPaletteOpen, run } = useShortcutsActions();
  const available = useAvailableCommands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const pending = useRef<string | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const entries = useMemo(() => entriesFor(commands, available, bindings, apple, t), [commands, available, bindings, apple, t]);
  const visible = useMemo(() => filterPaletteEntries(entries, query), [entries, query]);
  const current = Math.min(active, Math.max(visible.length - 1, 0));
  const listRef = useRef<HTMLDivElement | null>(null);

  // A command chosen in a palette that then closed without finishing (e.g. reopened at once) must not run later.
  useEffect(() => {
    if (paletteOpen) pending.current = null;
  }, [paletteOpen]);

  // Keep the keyboard-highlighted option visible in a long list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [current, visible]);

  const choose = (id: string) => {
    // Run after the palette has closed, so the command can move focus or open its own dialog.
    pending.current = id;
    setPaletteOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (visible.length > 0) setActive((current + step + visible.length) % visible.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = visible[current];
      if (entry) choose(entry.id);
    }
  };

  return (
    <DialogPrimitive.Root
      open={paletteOpen}
      onOpenChange={(open) => setPaletteOpen(open)}
      onOpenChangeComplete={(open) => {
        if (open) return;
        setQuery("");
        setActive(0);
        const id = pending.current;
        pending.current = null;
        if (id) run(id);
      }}
    >
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-tg-scrim transition-opacity duration-(--tg-duration-normal) data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center sm:px-4 sm:pt-[12vh]">
          <DialogPrimitive.Popup
            className={cx(
              "flex h-full w-full flex-col overflow-hidden bg-tg-surface-raised text-tg-foreground shadow-tg-overlay outline-none sm:h-auto sm:max-w-[35rem] sm:rounded-tg-lg",
              "transition-[opacity,scale] duration-(--tg-duration-fast) ease-tg-out data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0",
            )}
          >
            <DialogPrimitive.Title className="sr-only">{t("palette.title")}</DialogPrimitive.Title>
            <div className="flex items-center gap-2.5 border-b border-tg-border px-4 py-3">
              <Search aria-hidden className="size-4 shrink-0 text-tg-muted" />
              <input
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={visible.length > 0 ? optionId(current) : undefined}
                aria-label={t("palette.title")}
                placeholder={t("palette.placeholder")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                className="h-8 min-w-0 flex-1 border-0 bg-transparent text-tg-md text-tg-foreground outline-none placeholder:text-tg-subtle"
              />
              <Kbd className="tg-kbd-hint">Esc</Kbd>
            </div>
            <div ref={listRef} role="listbox" id={listId} aria-label={t("palette.title")} className="max-h-[23.75rem] overflow-auto p-1.5">
              {visible.map((entry, index) => (
                <div
                  key={entry.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === current}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(entry.id)}
                  className="flex min-h-(--tg-hit-target) cursor-pointer items-center gap-2.5 rounded-tg-sm px-2.5 py-2.25 aria-selected:bg-tg-accent aria-selected:shadow-[inset_3px_0_0_var(--tg-ring)]"
                >
                  <span className="min-w-0 flex-1 truncate text-tg-sm">{entry.title}</span>
                  {entry.keys && <span className="tg-kbd-hint shrink-0 font-tg-mono text-tg-xs text-tg-muted">{entry.keys}</span>}
                </div>
              ))}
              {visible.length === 0 && <p className="m-0 px-2.5 py-3 text-tg-sm text-tg-muted">{t("palette.empty")}</p>}
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
