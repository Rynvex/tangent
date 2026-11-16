/** The map's 魚眼 layer (C1, handoff §9-7: opacity = fisheye): its switch, each node's opacity and spoken level, the legend. */
import { normalizeBranchView, type FisheyeLevel } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap } from "./branch-map";

afterEach(cleanup);

const BRANCHES = ["near", "far", "gone"].map((id) => normalizeBranchView({ lineId: id, parentLineId: "root", rootLineId: "root", purpose: id, status: "merged" }));
const LEVELS = new Map<string, FisheyeLevel>([
  ["__main__", "full"],
  ["near", "leaf_only"],
  ["far", "summary"],
  ["gone", "hidden"],
]);

function setup(fisheye?: Parameters<typeof BranchMap>[0]["fisheye"]) {
  render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} {...(fisheye ? { fisheye } : {})} />);
  return screen.getByRole("group", { name: "Branch map" });
}

const level = (map: HTMLElement, key: string) => map.querySelector(`[data-tg-map-node="${key}"]`)?.getAttribute("data-fisheye-level");

describe("fisheye layer", () => {
  it("is offered only when the host gives it (the fisheye feature on)", () => {
    setup();
    expect(screen.queryByRole("group", { name: "Map layers" })).toBeNull();
  });

  it("starts off; the switch asks the host to turn it on", async () => {
    const onToggle = vi.fn();
    const map = setup({ on: false, onToggle, levels: null });
    const toggle = within(screen.getByRole("group", { name: "Map layers" })).getByRole("button", { name: "Fisheye" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(level(map, "near")).toBeNull();
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("on: each node's opacity follows its level, its name says it, and a legend explains", () => {
    const map = setup({ on: true, onToggle: vi.fn(), levels: LEVELS });
    expect(level(map, "__main__")).toBe("full");
    expect(level(map, "gone")).toBe("hidden");
    // The frame (surface, border, icon) fades; the words stay at full contrast and the level is printed.
    const opacity = (key: string) => map.querySelector(`[data-tg-map-node="${key}"] [data-tg-fisheye-frame]`)!.getAttribute("class")!.match(/opacity-\d+/)?.[0];
    expect([opacity("__main__"), opacity("far"), opacity("near"), opacity("gone")]).toEqual(["opacity-100", "opacity-75", "opacity-55", "opacity-30"]);
    expect(map.querySelector('[data-tg-map-node="near"]')).toHaveTextContent("AI sees: Ending only");
    expect(within(map).getByRole("button", { name: /^near, Brought back, AI sees: Ending only$/ })).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: "Opacity = how much AI sees" });
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["In full", "Summary", "Ending only", "Not seen"]);
  });
});
