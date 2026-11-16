import { DEFAULT_COMMANDS, resolveBindings } from "@tangent/react";
import { describe, expect, it } from "vitest";
import { conflictOf, recordKey, withBinding, type RecordedKeyEvent } from "./keybinding-record";

const key = (name: string, extra: Partial<RecordedKeyEvent> = {}): RecordedKeyEvent => ({ key: name, code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });
const command = (id: string) => DEFAULT_COMMANDS.find((item) => item.id === id)!;

describe("recording a key binding (G2)", () => {
  it("turns a key press into a binding: Mod is Ctrl elsewhere and ⌘ on Apple", () => {
    expect(recordKey(key("b", { ctrlKey: true }), false)).toEqual({ kind: "binding", keys: "Mod+B" });
    expect(recordKey(key("B", { metaKey: true, shiftKey: true }), true)).toEqual({ kind: "binding", keys: "Mod+Shift+B" });
    expect(recordKey(key("[", { ctrlKey: true }), false)).toEqual({ kind: "binding", keys: "Mod+[" });
    expect(recordKey(key("Enter", { ctrlKey: true }), false)).toEqual({ kind: "binding", keys: "Mod+Enter" });
    expect(recordKey(key("?", { shiftKey: true }), false)).toEqual({ kind: "binding", keys: "Shift+?" });
    expect(recordKey(key("F2"), false)).toEqual({ kind: "binding", keys: "F2" });
  });

  it("waits while only modifiers are down, and Esc alone cancels", () => {
    for (const name of ["Shift", "Control", "Alt", "Meta"]) expect(recordKey(key(name, { ctrlKey: true }), false)).toEqual({ kind: "pending" });
    expect(recordKey(key("Escape"), false)).toEqual({ kind: "cancel" });
    expect(recordKey(key("Escape", { ctrlKey: true }), false)).toEqual({ kind: "binding", keys: "Mod+Escape" });
  });

  it("refuses keys that would swallow typing or cannot be written", () => {
    expect(recordKey(key("a"), false)).toEqual({ kind: "invalid" });
    expect(recordKey(key("A", { shiftKey: true }), false)).toEqual({ kind: "invalid" });
    expect(recordKey(key("/"), false)).toEqual({ kind: "invalid" });
    expect(recordKey(key(" ", { ctrlKey: true }), false)).toEqual({ kind: "invalid" });
    expect(recordKey(key("Tab", { ctrlKey: true }), false)).toEqual({ kind: "invalid" });
    expect(recordKey(key("Enter"), false)).toEqual({ kind: "invalid" });
    // Ctrl on Apple, the Windows key elsewhere: neither is Mod.
    expect(recordKey(key("b", { ctrlKey: true }), true)).toEqual({ kind: "invalid" });
    expect(recordKey(key("b", { metaKey: true }), false)).toEqual({ kind: "invalid" });
  });

  it("lets the message box's commands take Enter by itself", () => {
    expect(recordKey(key("Enter"), false, true)).toEqual({ kind: "binding", keys: "Enter" });
  });

  it("reads the physical key when Alt or a non-Latin layout changed the character", () => {
    expect(recordKey(key("∫", { altKey: true, code: "KeyB" }), true)).toEqual({ kind: "binding", keys: "Alt+B" });
    expect(recordKey(key("и", { ctrlKey: true, code: "KeyB" }), false)).toEqual({ kind: "binding", keys: "Mod+B" });
    expect(recordKey(key("∫", { altKey: true, code: "IntlBackslash" }), true)).toEqual({ kind: "invalid" });
  });

  it("records bindings the shortcut registry accepts", () => {
    const recorded = recordKey(key("L", { ctrlKey: true, shiftKey: true }), false);
    if (recorded.kind !== "binding") throw new Error("not a binding");
    const warnings: string[] = [];
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "branch.open": recorded.keys }, (message) => warnings.push(message));
    expect(bindings.get("branch.open")).toBe("Mod+Shift+L");
    expect(warnings).toEqual([]);
  });
});

describe("conflicts and overrides", () => {
  const bindings = resolveBindings(DEFAULT_COMMANDS);

  it("names the other command that has the keys now, however they are written", () => {
    expect(conflictOf("Mod+B", "notes.add", DEFAULT_COMMANDS, bindings)?.id).toBe("branch.open");
    expect(conflictOf("mod+shift+s", "notes.add", DEFAULT_COMMANDS, bindings)?.id).toBe("composer.park");
    expect(conflictOf("Mod+B", "branch.open", DEFAULT_COMMANDS, bindings)).toBeNull();
    expect(conflictOf("Mod+Shift+L", "branch.open", DEFAULT_COMMANDS, bindings)).toBeNull();
  });

  it("keeps only real changes: a command's default keys are no override, null resets", () => {
    expect(withBinding({}, command("branch.open"), "Mod+Shift+L")).toEqual({ "branch.open": "Mod+Shift+L" });
    expect(withBinding({ "branch.open": "Mod+Shift+L" }, command("branch.open"), "mod+b")).toEqual({});
    expect(withBinding({ "branch.open": "Mod+Shift+L", "notes.add": "Alt+N" }, command("branch.open"), null)).toEqual({ "notes.add": "Alt+N" });
    // A palette-only command (no default keys) takes any.
    expect(withBinding({}, command("conversation.new"), "Alt+N")).toEqual({ "conversation.new": "Alt+N" });
  });
});
