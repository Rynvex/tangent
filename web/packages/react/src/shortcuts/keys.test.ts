import { describe, expect, it, vi } from "vitest";
import { DEFAULT_COMMANDS, PALETTE_COMMAND_ID, resolveBindings } from "./commands";
import { canonicalKeys, formatKeys, formatKeysText, isApplePlatform, isComposing, matchesKeys, parseKeys, type KeyEventLike } from "./keys";

function key(over: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe("parseKeys / canonicalKeys", () => {
  it("parses modifiers in any case and order", () => {
    expect(parseKeys("Mod+Shift+S")).toEqual({ mod: true, shift: true, alt: false, key: "s" });
    expect(parseKeys("shift+mod+s")).toEqual(parseKeys("Mod+Shift+S"));
    expect(parseKeys("Escape")).toEqual({ mod: false, shift: false, alt: false, key: "escape" });
    expect(parseKeys("Mod++")).toEqual({ mod: true, shift: false, alt: false, key: "+" });
    expect(canonicalKeys("Shift+Mod+P")).toBe("mod+shift+p");
  });

  it("rejects typos instead of silently never matching", () => {
    expect(() => parseKeys("Cmd+K")).toThrow(/unknown modifier/);
    expect(() => parseKeys("")).toThrow(/invalid/);
  });
});

describe("matchesKeys", () => {
  const modK = parseKeys("Mod+K");

  it("uses ⌘ on Apple platforms and Ctrl elsewhere", () => {
    expect(matchesKeys(key({ key: "k", metaKey: true }), modK, true)).toBe(true);
    expect(matchesKeys(key({ key: "k", ctrlKey: true }), modK, true)).toBe(false);
    expect(matchesKeys(key({ key: "k", ctrlKey: true }), modK, false)).toBe(true);
    expect(matchesKeys(key({ key: "k", metaKey: true }), modK, false)).toBe(false);
  });

  it("requires the exact modifiers", () => {
    expect(matchesKeys(key({ key: "K", ctrlKey: true, shiftKey: true }), modK, false)).toBe(false);
    expect(matchesKeys(key({ key: "Enter" }), parseKeys("Enter"), false)).toBe(true);
    expect(matchesKeys(key({ key: "Enter", shiftKey: true }), parseKeys("Enter"), false)).toBe(false);
    expect(matchesKeys(key({ key: "Enter", shiftKey: true }), parseKeys("Shift+Enter"), false)).toBe(true);
  });

  it("matches letters by the layout's key: Dvorak and Colemak are not hijacked (F0 review H2)", () => {
    const modB = parseKeys("Mod+B");
    // Dvorak: the QWERTY B position types "x"; B sits on QWERTY N.
    expect(matchesKeys(key({ key: "x", code: "KeyB", ctrlKey: true }), modB, false)).toBe(false);
    expect(matchesKeys(key({ key: "b", code: "KeyN", ctrlKey: true }), modB, false)).toBe(true);
    // Colemak: QWERTY K types "e"; K sits on QWERTY N.
    const modK = parseKeys("Mod+K");
    expect(matchesKeys(key({ key: "e", code: "KeyK", ctrlKey: true }), modK, false)).toBe(false);
    expect(matchesKeys(key({ key: "k", code: "KeyN", ctrlKey: true }), modK, false)).toBe(true);
    expect(matchesKeys(key({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }), parseKeys("Mod+Shift+S"), false)).toBe(true);
  });

  it("uses the physical key for non-Latin layouts and for punctuation that Shift or Alt changed", () => {
    expect(matchesKeys(key({ key: "ㄖ", code: "KeyB", ctrlKey: true }), parseKeys("Mod+B"), false)).toBe(true);
    expect(matchesKeys(key({ key: "и", code: "KeyB", ctrlKey: true }), parseKeys("Mod+B"), false)).toBe(true);
    expect(matchesKeys(key({ key: "∫", code: "KeyB", metaKey: true, altKey: true }), parseKeys("Mod+Alt+B"), true)).toBe(true);
    expect(matchesKeys(key({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), parseKeys("Mod+Shift+["), false)).toBe(true);
    expect(matchesKeys(key({ key: "「", code: "BracketLeft", metaKey: true }), parseKeys("Mod+["), true)).toBe(true);
    // A Latin layout whose "[" lives elsewhere: the key that types "/" there is not Mod+[.
    expect(matchesKeys(key({ key: "/", code: "BracketLeft", ctrlKey: true }), parseKeys("Mod+["), false)).toBe(false);
  });

  it("never fires while an input method is composing (isComposing or keyCode 229)", () => {
    expect(isComposing(key({ key: "Enter", isComposing: true }))).toBe(true);
    expect(matchesKeys(key({ key: "Enter", isComposing: true }), parseKeys("Enter"), false)).toBe(false);
    expect(matchesKeys(key({ key: "Process", keyCode: 229, code: "KeyB", ctrlKey: true }), parseKeys("Mod+B"), false)).toBe(false);
  });
});

describe("formatKeys and platform", () => {
  it("formats for Apple and for Windows / Linux", () => {
    expect(formatKeys("Mod+Shift+S", true)).toEqual(["⌘", "⇧", "S"]);
    expect(formatKeys("Mod+Shift+S", false)).toEqual(["Ctrl", "Shift", "S"]);
    expect(formatKeys("Escape", false)).toEqual(["Esc"]);
    expect(formatKeys("Mod+[", true)).toEqual(["⌘", "["]);
    expect(formatKeysText("Mod+Shift+S", true)).toBe("⌘⇧S");
    expect(formatKeysText("Mod+B", false)).toBe("Ctrl+B");
  });

  it("detects Apple platforms from userAgentData, platform or the user agent", () => {
    expect(isApplePlatform({ userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })).toBe(true);
    expect(isApplePlatform({ platform: "Win32" })).toBe(false);
    expect(isApplePlatform({ platform: "Linux x86_64" })).toBe(false);
  });
});

describe("resolveBindings", () => {
  it("uses the defaults of shortcuts.md", () => {
    const bindings = resolveBindings(DEFAULT_COMMANDS);
    expect(bindings.get(PALETTE_COMMAND_ID)).toBe("Mod+K");
    expect(bindings.get("branch.open")).toBe("Mod+B");
    expect(bindings.get("composer.send")).toBe("Enter");
    // F3: "save the selection to the notes" (shortcuts.md 規格).
    expect(bindings.get("notes.add")).toBe("Mod+Shift+N");
  });

  it("lets the host rebind or turn off a command; the host wins a conflict", () => {
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "sidebar.toggle": null, "turn.preview": "Mod+B" });
    expect(bindings.get("sidebar.toggle")).toBeNull();
    expect(bindings.get("turn.preview")).toBe("Mod+B");
    expect(bindings.get("branch.open")).toBeNull();
  });

  it("keeps the command palette reachable: it can be rebound, not removed", () => {
    expect(resolveBindings(DEFAULT_COMMANDS, { [PALETTE_COMMAND_ID]: null }).get(PALETTE_COMMAND_ID)).toBe("Mod+K");
    expect(resolveBindings(DEFAULT_COMMANDS, { [PALETTE_COMMAND_ID]: "Mod+P" }).get(PALETTE_COMMAND_ID)).toBe("Mod+P");
  });

  it("ignores overrides for unknown commands, with a warning", () => {
    const warn = vi.fn();
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "no.such": "Mod+B" }, warn);
    expect(bindings.get("branch.open")).toBe("Mod+B");
    expect(bindings.has("no.such")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown command "no.such"'));
  });

  it("never lets an override take the palette's keys (F0 review M4)", () => {
    const warn = vi.fn();
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "branch.open": "Mod+K" }, warn);
    expect(bindings.get(PALETTE_COMMAND_ID)).toBe("Mod+K");
    expect(bindings.get("branch.open")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    const moved = resolveBindings(DEFAULT_COMMANDS, { [PALETTE_COMMAND_ID]: "Mod+P", "branch.open": "Mod+P" });
    expect([moved.get(PALETTE_COMMAND_ID), moved.get("branch.open")]).toEqual(["Mod+P", null]);
  });

  it("skips a malformed binding instead of throwing, keeping the default (F0 review M5)", () => {
    const warn = vi.fn();
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "branch.open": "Cmd+B", [PALETTE_COMMAND_ID]: "Hyper+K" }, warn);
    expect(bindings.get("branch.open")).toBe("Mod+B");
    expect(bindings.get(PALETTE_COMMAND_ID)).toBe("Mod+K");
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("gives clashing overrides' keys to the first one, with a warning", () => {
    const warn = vi.fn();
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "turn.preview": "Mod+J", "sidebar.toggle": "Mod+J" }, warn);
    expect([bindings.get("turn.preview"), bindings.get("sidebar.toggle")]).toEqual(["Mod+J", null]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"turn.preview" already has it'));
  });
});
