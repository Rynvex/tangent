# @tangent/react

React provider, i18n, query keys, design tokens, base components, the layout frame and keyboard shortcuts for Tangent
(DESIGN §8). Business components (messages, branches, notes) arrive in F1–F3.

## Setup

```css
/* the host's Tailwind entry */
@import "tailwindcss";
@import "@tangent/react/styles.css";
@source "<path to>/@tangent/react/src";
```

```tsx
<TangentProvider client={client} locale="zh-TW">
  <TangentRoot theme="host">
    <ShortcutsProvider>
      {/* Tangent UI */}
      <CommandPalette />
    </ShortcutsProvider>
  </TangentRoot>
</TangentProvider>
```

Fonts are optional and live in `@tangent/fonts` (`latin.css`, `tc.css`, `serif.css`, `host.css`); a host that brings its own
fonts does not depend on it.

## TangentRoot and styles

- Every rule of `styles.css` is scoped under `[data-tg-root]`: tokens, color-scheme, base type and the touch / reduced-motion
  adjustments exist only inside a `TangentRoot`. Only the `tg-*` keyframes and Tailwind's `@theme` mapping are global.
- `theme`: `system` (OS), `light`, `dark` or `host` → `data-tg-theme`; `density`: `comfortable` / `compact` →
  `data-tg-density`. A container inside the root can carry its own `data-tg-theme`.
- The root sets `isolation: isolate` and owns the popup container: dialogs, menus, popovers, selects and tooltips portal
  into it (from the very first render), so they keep the theme and stack above the root's content.

**Constraint for hosts:** popups are `position: fixed`. If an ancestor of the `TangentRoot` has `transform`, `filter`,
`perspective`, `contain: paint|layout` or `will-change: transform`, that ancestor becomes the containing block: popups are
positioned and clipped relative to it instead of the viewport. Keep such properties off the root's ancestors (or put the
root outside the transformed element).

## Shortcuts

`ShortcutsProvider` holds the commands of `shortcuts.md`; components register actions with `useCommand(id, handler)`.

- **Where keys are heard:** by default only while focus is inside the enclosing `TangentRoot` (an embedded Tangent never
  reacts to the host's keys, and two instances never both fire). A full-page app passes `target="window"`.
- **Host bindings:** `bindings={{ "branch.open": "Mod+Shift+B", "sidebar.toggle": null }}`. `Mod` is ⌘ on Apple platforms
  and Ctrl elsewhere. An override wins over defaults that used the same keys; `null` turns a command's keys off (it stays
  in the palette). The command palette can be rebound but never removed, and no override can take its keys. Malformed
  strings and unknown ids are reported to `onWarning` (console.warn by default) and skipped, never thrown.
- **Layouts and IME:** letters and digits match the layout's character (Dvorak's Ctrl+X stays Ctrl+X); the physical key
  is used only for non-Latin layouts and for punctuation that Shift / Alt changed. Nothing fires while an input method is
  composing, for a held (repeating) key, or for an event another handler already took. Keys without ⌘/Ctrl/Alt never fire
  from text fields; inside dialogs and menus only the palette does.
- **Esc:** the provider is the single owner. Open panels and overlays register with `useEscapeLayer` and close before
  `nav.back` runs; popups (dialogs, menus) handle their own Esc.

**Browser-reserved combinations.** Browsers keep some combinations for themselves and the page never sees them, or sees
them only after the browser acted:

| Binding | Conflict |
|---|---|
| Mod+Shift+P | Firefox: new private window (Windows / Linux Ctrl+Shift+P, macOS ⌘⇧P) — never reaches the page |
| Mod+Shift+M | Firefox: responsive design mode (Ctrl+Shift+M / ⌘⌥M) when devtools are enabled |
| Mod+Shift+S | Firefox: screenshot (Ctrl+Shift+S) on some versions |
| Mod+[ | Safari / Firefox on macOS: history back (⌘[) — the page receives it and prevents the default |
| Mod+B | Firefox: bookmarks sidebar (Ctrl+B) — the page receives it and prevents the default |

Hosts that need these in Firefox should rebind them through `bindings`; the palette always lists the commands.
