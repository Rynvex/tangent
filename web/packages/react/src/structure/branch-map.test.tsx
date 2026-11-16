import { normalizeBranchView, type BranchView } from "@tangent/client";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap, MAP_ZOOM_MAX, MAP_ZOOM_MIN } from "./branch-map";

afterEach(cleanup);

let seq = 0;
function view(id: string, parent: string, extra: Record<string, unknown> = {}): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: id, status: "open", createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
}

const BRANCHES = [view("alpha", "root"), view("alpha-one", "alpha", { unread: 2 }), view("beta", "root", { status: "merged", conclusionLine: "Use ZFS" })];

function setup(props: Partial<Parameters<typeof BranchMap>[0]> = {}) {
  const onEnter = vi.fn();
  render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="alpha-one" mainCount={12} onEnter={onEnter} {...props} />);
  const map = screen.getByRole("group", { name: "Branch map" });
  return { onEnter, map };
}

describe("BranchMap (A8, components.md)", () => {
  it("draws the main line and every branch as a node; a node enters its line", async () => {
    const { map, onEnter } = setup();
    expect(within(map).getByRole("button", { name: "Main line, 12 messages" })).toBeInTheDocument();
    await userEvent.click(within(map).getByRole("button", { name: "beta, Brought back" }));
    expect(onEnter).toHaveBeenCalledWith("beta");
    await userEvent.click(within(map).getByRole("button", { name: "Main line, 12 messages" }));
    expect(onEnter).toHaveBeenLastCalledWith("root");
    expect(map).toHaveTextContent("Use ZFS");
  });

  it("highlights the path to the current line", () => {
    const { map } = setup();
    expect(within(map).getByRole("button", { name: "alpha-one, Open" })).toHaveAttribute("aria-current", "location");
    const onPath = [...map.querySelectorAll("[data-tg-map-node][data-on-path]")].map((node) => node.getAttribute("data-tg-map-node"));
    expect(onPath.sort()).toEqual(["__main__", "alpha", "alpha-one"]);
    expect(map.querySelectorAll("path[data-on-path]")).toHaveLength(2);
  });

  it("zooms between 50 % and 160 % with the buttons and with + − 0", async () => {
    const { map } = setup();
    const label = () => screen.getByRole("status", { name: /Zoom/ }).textContent;
    expect(label()).toBe("100%");
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(label()).toBe("110%");
    map.focus();
    for (let i = 0; i < 10; i += 1) await userEvent.keyboard("+");
    expect(label()).toBe(`${MAP_ZOOM_MAX * 100}%`);
    for (let i = 0; i < 20; i += 1) await userEvent.keyboard("-");
    expect(label()).toBe(`${MAP_ZOOM_MIN * 100}%`);
    Object.defineProperty(map, "clientWidth", { configurable: true, value: 400 });
    Object.defineProperty(map, "clientHeight", { configurable: true, value: 2000 });
    await userEvent.keyboard("0");
    // Fit: the map is 3 columns of 236 + padding wide, so 400 px is a little over half.
    expect(Number.parseInt(label() ?? "", 10)).toBeGreaterThanOrEqual(50);
    expect(Number.parseInt(label() ?? "", 10)).toBeLessThan(100);
  });

  it("folds and unfolds the branches under a node", async () => {
    const { map } = setup();
    await userEvent.click(within(map).getByRole("button", { name: "Fold the branches below alpha" }));
    expect(within(map).queryByRole("button", { name: "alpha-one, Open" })).toBeNull();
    await userEvent.click(within(map).getByRole("button", { name: "Show 1 folded branch(es) below alpha" }));
    expect(within(map).getByRole("button", { name: "alpha-one, Open" })).toBeInTheDocument();
  });

  it("pans by dragging the empty canvas", () => {
    const { map } = setup();
    map.scrollLeft = 100;
    map.scrollTop = 50;
    fireEvent.pointerDown(map, { clientX: 200, clientY: 200, pointerId: 1, button: 0 });
    fireEvent.pointerMove(map, { clientX: 150, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(map, { pointerId: 1 });
    expect([map.scrollLeft, map.scrollTop]).toEqual([150, 70]);
  });

  it("offers full width when the host supports it", async () => {
    const onToggleFullscreen = vi.fn();
    setup({ onToggleFullscreen });
    await userEvent.click(screen.getByRole("button", { name: "Full width" }));
    expect(onToggleFullscreen).toHaveBeenCalled();
  });

  it("offers fold toggles only at a zoom where they stay 24 px targets apart from the next column", async () => {
    const { map } = setup();
    map.focus();
    for (let i = 0; i < 4; i += 1) await userEvent.keyboard("-");
    expect(within(map).queryByRole("button", { name: /^Fold the branches below/ })).toBeNull();
    for (let i = 0; i < 4; i += 1) await userEvent.keyboard("+");
    expect(within(map).getAllByRole("button", { name: /^Fold the branches below/ }).length).toBeGreaterThan(0);
  });
});

describe("BranchMap: leaves at the ends (B1)", () => {
  it("puts the leaf on an ended node when leaves are on, and nothing of it when off", () => {
    const branches = [view("done", "root", { status: "merged", conclusionLine: "Use ZFS", leaf: { kind: "decision", line: "ZFS mirror", status: "confirmed" } })];
    render(<BranchMap branches={branches} rootLineId="root" currentLineId="root" onEnter={vi.fn()} showLeaves />);
    const node = screen.getByRole("button", { name: /^done, Brought back/ });
    expect(node.querySelector('[data-tg-leaf="decision"]')).not.toBeNull();
    expect(node).toHaveTextContent("ZFS mirror");
    cleanup();
    render(<BranchMap branches={branches} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    expect(document.querySelector("[data-tg-leaf]")).toBeNull();
  });
});

