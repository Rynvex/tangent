import { describe, expect, it } from "vitest";
import { createShortcutRegistry, ESCAPE_PRIORITY } from "./registry";

describe("shortcut registry (F0 review M8, LOW duplicate ids)", () => {
  it("keeps the same available Set while the list of ids does not change, and notifies only on change", () => {
    const registry = createShortcutRegistry(["palette.open"]);
    let notified = 0;
    registry.subscribe(() => {
      notified += 1;
    });
    const before = registry.available();
    const offA = registry.register("branch.open", { current: () => {} });
    const withBranch = registry.available();
    expect(withBranch).not.toBe(before);
    const offB = registry.register("branch.open", { current: () => {} });
    expect(registry.available()).toBe(withBranch);
    offB();
    expect(registry.available()).toBe(withBranch);
    offA();
    expect([...registry.available()]).toEqual(["palette.open"]);
    expect(notified).toBe(2);
  });

  it("runs the newest registration and restores the previous one when it goes", () => {
    const registry = createShortcutRegistry([]);
    const first = { current: () => {} };
    const second = { current: () => {} };
    registry.register("x", first);
    const off = registry.register("x", second);
    expect(registry.handler("x")).toBe(second);
    off();
    expect(registry.handler("x")).toBe(first);
  });

  it("gives Esc to the highest-priority, newest layer", () => {
    const registry = createShortcutRegistry([]);
    const panel = { priority: ESCAPE_PRIORITY.panel, onEscape: { current: () => {} } };
    const overlay = { priority: ESCAPE_PRIORITY.overlay, onEscape: { current: () => {} } };
    const panel2 = { priority: ESCAPE_PRIORITY.panel, onEscape: { current: () => {} } };
    registry.addEscapeLayer(panel);
    const offOverlay = registry.addEscapeLayer(overlay);
    registry.addEscapeLayer(panel2);
    expect(registry.topEscapeLayer()).toBe(overlay);
    offOverlay();
    expect(registry.topEscapeLayer()).toBe(panel2);
  });
});
