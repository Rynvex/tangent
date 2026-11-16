import { MAP_ROOT_KEY, normalizeBranchView, type BranchView } from "@tangent/client";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap, type BranchMapProps } from "./branch-map";
import { NODE_FADE_MS } from "./use-map-focus";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const view = (id: string, parent: string, extra: Record<string, unknown> = {}): BranchView =>
  normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: id, status: "open", createdAt: "2026-01-01T00:00:00Z", ...extra });

const BRANCHES = [view("alpha", "root"), view("alpha-one", "alpha"), view("beta", "root"), view("beta-one", "beta")];

function setup(props: Partial<BranchMapProps> = {}) {
  const onEnter = vi.fn();
  const onSelect = vi.fn();
  const onManualMove = vi.fn();
  const base: BranchMapProps = { branches: BRANCHES, rootLineId: "root", currentLineId: "alpha", mainCount: 3, onEnter, onSelect, onManualMove, follow: true };
  const result = render(<BranchMap {...base} {...props} />);
  const map = screen.getByRole("group", { name: "Branch map" });
  const node = (name: string) => within(map).getByRole("button", { name: new RegExp(`^${name},`) });
  return { onEnter, onSelect, onManualMove, map, node, rerender: (next: Partial<BranchMapProps>) => result.rerender(<BranchMap {...base} {...props} {...next} />) };
}

describe("BranchMap in focus mode (FOCUS_MODE.md §6.2)", () => {
  it("a click only chooses a node; double-click and Enter enter its line", async () => {
    const { node, onSelect, onEnter } = setup();
    await userEvent.click(node("beta"));
    expect(onSelect).toHaveBeenCalledWith("beta");
    expect(onEnter).not.toHaveBeenCalled();
    await userEvent.dblClick(node("beta"));
    expect(onEnter).toHaveBeenCalledWith("beta");
    node("alpha-one").focus();
    await userEvent.keyboard("{Enter}");
    expect(onEnter).toHaveBeenLastCalledWith("alpha-one");
    onSelect.mockClear();
    await userEvent.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith("alpha-one");
  });

  it("while multi-selecting, Enter and double-click pick the node instead of entering it", async () => {
    const { node, onEnter } = setup({ groups: { on: false, onToggle: vi.fn(), groups: [], selection: () => null } });
    await userEvent.click(screen.getByRole("button", { name: "Select several" }));
    node("beta").focus();
    await userEvent.keyboard("{Enter}");
    expect(node("beta")).toHaveAttribute("aria-pressed", "true");
    expect(onEnter).not.toHaveBeenCalled();
    await userEvent.dblClick(node("alpha-one"));
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("chooses the main line by the root's id", async () => {
    const { map, onSelect } = setup();
    await userEvent.click(within(map).getByRole("button", { name: /^Main line/ }));
    expect(onSelect).toHaveBeenCalledWith("root");
  });

  it("marks the chosen node apart from the multi-select, and tags where the chat is", () => {
    const { map, node } = setup({ selectedLineId: "beta" });
    expect(node("beta")).toHaveAttribute("aria-expanded", "true");
    expect(node("beta")).not.toHaveAttribute("aria-pressed");
    expect(node("alpha-one")).toHaveAttribute("aria-expanded", "false");
    const here = map.querySelector('[data-tg-map-node="alpha"]');
    expect(here).toHaveTextContent("You are here");
  });

  it("without onSelect a click still enters (side panel and full-width map)", async () => {
    const { node, onEnter } = setup({ onSelect: undefined, follow: undefined });
    await userEvent.click(node("beta"));
    expect(onEnter).toHaveBeenCalledWith("beta");
    expect(node("beta")).not.toHaveAttribute("aria-expanded");
  });
});

describe("focused subtree (§6.3)", () => {
  it("fades the nodes and links outside the subtree and says so", () => {
    const { map, node } = setup({ focusLineId: "beta" });
    const dimmed = [...map.querySelectorAll("[data-tg-dimmed]")].map((item) => item.getAttribute("data-tg-map-node")).sort();
    expect(dimmed).toEqual(["alpha", "alpha-one"]);
    expect(node("alpha")).toHaveAttribute("aria-description", "Outside the focus");
    expect(node("beta-one")).not.toHaveAttribute("aria-description");
    const faded = [...map.querySelectorAll("path.opacity-20")];
    expect(faded).toHaveLength(2);
  });

  it("keeps the 你在這裡 tag lit on a faded current node", () => {
    const { map } = setup({ focusLineId: "beta" });
    const tag = within(map.querySelector<HTMLElement>('[data-tg-map-node="alpha"]')!).getByText("You are here");
    expect(tag.className).not.toContain("opacity-30");
  });
});

describe("a reply being written (S9)", () => {
  it("spins on the node's icon and says so, in focus mode only", () => {
    const branches = [view("alpha", "root"), view("beta", "root", { lineStatus: "thinking" })];
    const { map, node } = setup({ branches });
    expect(node("beta")).toHaveAccessibleName("beta, Open, replying");
    expect(map.querySelector('[data-tg-map-node="beta"] [data-tg-replying]')).not.toBeNull();
    cleanup();
    const plain = setup({ branches, onSelect: undefined, follow: undefined });
    expect(plain.node("beta")).toHaveAccessibleName("beta, Open");
  });
});

describe("note marks (§8.4)", () => {
  it("counts memos into the mark and names both kinds (B13)", () => {
    const { map, node } = setup({ noteCounts: new Map([["beta", 2]]), memoCounts: new Map([["beta", 1], ["alpha-one", 3]]) });
    expect(node("beta")).toHaveAccessibleName("beta, Open, 2 notes, 1 memos");
    expect(node("alpha-one")).toHaveAccessibleName("alpha-one, Open, 3 memos");
    expect(map.querySelector('[data-tg-map-node="beta"] [data-tg-note-count]')).toHaveTextContent("3");
  });

  it("shows a node's note count and names it", () => {
    const { map, node } = setup({ noteCounts: new Map([["beta", 2], [MAP_ROOT_KEY, 1]]) });
    expect(node("beta")).toHaveAccessibleName("beta, Open, 2 notes");
    expect(map.querySelector('[data-tg-map-node="beta"] [data-tg-note-count]')).toHaveTextContent("2");
    expect(map.querySelector('[data-tg-map-node="alpha"] [data-tg-note-count]')).toBeNull();
  });
});

describe("following (§6.1)", () => {
  it("brings the new current line into view while following", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    const { map, rerender } = setup();
    Object.defineProperty(map, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(map, "clientHeight", { configurable: true, value: 120 });
    rerender({ currentLineId: "beta-one" });
    expect(scrollTo).toHaveBeenCalled();
    scrollTo.mockClear();
    rerender({ currentLineId: "alpha-one", follow: false });
    expect(scrollTo).not.toHaveBeenCalled();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  it("jumps instead of gliding when the viewer asks for less motion", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    // jsdom has no matchMedia: this one says motion should be reduced.
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: query.includes("reduce"), media: query }) });
    const { map, rerender } = setup();
    Object.defineProperty(map, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(map, "clientHeight", { configurable: true, value: 120 });
    rerender({ currentLineId: "beta-one" });
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    Reflect.deleteProperty(window, "matchMedia");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  it("glows the nodes whose fork point is in view", () => {
    const { map } = setup({ highlighted: new Set(["beta"]) });
    expect(map.querySelector('[data-tg-map-node="beta"]')).toHaveAttribute("data-tg-glow", "");
    expect(map.querySelector('[data-tg-map-node="alpha"]')).not.toHaveAttribute("data-tg-glow");
  });

  it("a zoom, a wheel or a drag by hand counts as a manual move; choosing a node does not", async () => {
    const { map, node, onManualMove } = setup();
    await userEvent.click(node("beta"));
    expect(onManualMove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onManualMove).toHaveBeenCalledTimes(1);
    fireEvent.wheel(map);
    expect(onManualMove).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(map, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(map, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(map);
    expect(onManualMove).toHaveBeenCalledTimes(3);
  });

  it("fades a node in once when it appears, not on the first drawing", () => {
    vi.useFakeTimers();
    const { map, rerender } = setup();
    expect(map.querySelectorAll('[class*="tg-fade-in"]')).toHaveLength(0);
    rerender({ branches: [...BRANCHES, view("gamma", "root")] });
    const fresh = () => [...map.querySelectorAll('[class*="tg-fade-in"]')].map((item) => item.getAttribute("data-tg-map-node"));
    expect(fresh()).toEqual(["gamma"]);
    act(() => vi.advanceTimersByTime(NODE_FADE_MS));
    expect(fresh()).toEqual([]);
  });
});
