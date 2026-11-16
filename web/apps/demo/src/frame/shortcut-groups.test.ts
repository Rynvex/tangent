import { DEFAULT_COMMANDS, resolveBindings } from "@tangent/react";
import { describe, expect, it } from "vitest";
import { isFirefoxReserved, isPhysicalKey, shortcutSections, shortcutsHelpAvailable } from "./shortcut-groups";

/** F8 S4: the shortcut list's model. */

const ids = (sections: ReturnType<typeof shortcutSections>) => Object.fromEntries(sections.map((section) => [section.group, section.rows.map((row) => row.id)]));

describe("shortcutSections", () => {
  it("lists every command with keys in four groups, palette-only commands left out", () => {
    const sections = shortcutSections(DEFAULT_COMMANDS, resolveBindings(DEFAULT_COMMANDS));
    expect(sections.map((section) => section.group)).toEqual(["nav", "branch", "notes", "focus"]);
    const grouped = ids(sections);
    expect(grouped.nav).toEqual(expect.arrayContaining(["palette.open", "search.inTree", "nav.mainLine", "nav.back", "shortcuts.help", "composer.send"]));
    expect(grouped.branch).toEqual(["branch.open", "branch.bringBack"]);
    expect(grouped.notes).toEqual(["composer.park", "notes.add"]);
    expect(grouped.focus).toEqual(["focus.toggle"]);
    const all = sections.flatMap((section) => section.rows.map((row) => row.id));
    for (const paletteOnly of ["export.open", "theme.toggle", "conversation.new", "review.open"]) expect(all).not.toContain(paletteOnly);
  });

  it("shows a host's own keys and leaves out keys the host turned off", () => {
    const bindings = resolveBindings(DEFAULT_COMMANDS, { "branch.open": "Mod+Shift+B", "focus.toggle": null });
    const sections = shortcutSections(DEFAULT_COMMANDS, bindings);
    expect(sections.flatMap((section) => section.rows).find((row) => row.id === "branch.open")?.keys).toBe("Mod+Shift+B");
    expect(sections.map((section) => section.group)).not.toContain("focus");
  });

  it("puts a host's own command under navigation", () => {
    const commands = [...DEFAULT_COMMANDS, { id: "host.thing", titleKey: "command.nav.back" as const, keys: "Mod+J", scope: "global" as const, palette: true }];
    expect(ids(shortcutSections(commands, resolveBindings(commands))).nav).toContain("host.thing");
  });

  it("marks the keys Firefox keeps for itself", () => {
    const rows = shortcutSections(DEFAULT_COMMANDS, resolveBindings(DEFAULT_COMMANDS)).flatMap((section) => section.rows);
    expect(rows.filter((row) => row.firefox).map((row) => row.id).sort()).toEqual(["composer.park", "structure.toggleView", "turn.preview"]);
    expect(isFirefoxReserved("Mod+B")).toBe(false);
    expect(isFirefoxReserved("not a + binding+")).toBe(false);
  });
});

describe("shortcutsHelpAvailable (decision #12)", () => {
  const coarse = (matches: boolean) => ({ matchMedia: () => ({ matches }) });

  it("hides the list on a touch-only screen until a physical key is pressed", () => {
    expect(shortcutsHelpAvailable(coarse(true), false)).toBe(false);
    expect(shortcutsHelpAvailable(coarse(true), true)).toBe(true);
    expect(shortcutsHelpAvailable(coarse(false), false)).toBe(true);
    expect(shortcutsHelpAvailable(undefined, false)).toBe(true);
    expect(shortcutsHelpAvailable({}, false)).toBe(true);
  });

  it("does not count an on-screen keyboard's keys", () => {
    expect(isPhysicalKey({ key: "a", keyCode: 65 })).toBe(true);
    expect(isPhysicalKey({ key: "Unidentified" })).toBe(false);
    expect(isPhysicalKey({ key: "Process", keyCode: 229 })).toBe(false);
  });
});
