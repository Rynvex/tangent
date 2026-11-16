/** The map's 群組 layer and multi-select (C2, handoff §9-7: the frame = a group): frames, the XMind bracket and summary, selecting nodes for an action. */
import { normalizeBranchView, normalizeGroup, type BranchView } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap, type MapGroupsProps } from "./branch-map";

afterEach(cleanup);

const ended = (id: string) => normalizeBranchView({ lineId: id, parentLineId: "root", rootLineId: "root", purpose: id, status: "merged", conclusionLine: "done" });
const BRANCHES = [ended("disk-a"), ended("disk-b"), ended("router")];
const GROUP = normalizeGroup({ id: "g1", title: "Disks", memberLineIds: ["disk-a", "disk-b"], status: "active", summaryStatus: "ready", summary: "New 8 TB is cheapest per TB" });

function setup(groups?: Partial<MapGroupsProps>) {
  const props: MapGroupsProps = { on: true, onToggle: vi.fn(), groups: [GROUP], ...groups };
  render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} groups={props} />);
  return { props, map: screen.getByRole("group", { name: "Branch map" }) };
}

describe("group layer", () => {
  it("is offered only when the host gives it (the group feature on)", () => {
    render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Map layers" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select several" })).toBeNull();
  });

  it("frames the members and puts the shared summary beside a bracket", () => {
    const { map } = setup();
    expect(within(screen.getByRole("group", { name: "Map layers" })).getByRole("button", { name: "Groups" })).toHaveAttribute("aria-pressed", "true");
    expect(map.querySelectorAll("[data-tg-group-frame]")).toHaveLength(1);
    expect(map.querySelector("[data-tg-group-bracket]")).not.toBeNull();
    const summary = within(map).getByRole("article", { name: "Group · Disks" });
    expect(summary).toHaveTextContent("New 8 TB is cheapest per TB");
  });

  it("says when the summary is being written (no motion when reduced) or was not written", () => {
    const { map } = setup({ groups: [{ ...GROUP, summaryStatus: "drafting", summary: "" }] });
    const drafting = within(map).getByText("Writing the shared summary…");
    // The text never fades (contrast); only the spinner turns, and not when motion is reduced.
    expect(drafting.className).not.toMatch(/animate-/);
    const spinner = drafting.querySelector("[data-tg-working]")!;
    expect(spinner.getAttribute("class")).toContain("motion-safe:animate-");
    expect(spinner.getAttribute("class")).not.toMatch(/(^| )animate-/);
    cleanup();
    const failed = setup({ groups: [{ ...GROUP, summaryStatus: "failed" }] });
    expect(within(failed.map).getByRole("article", { name: "Group · Disks" })).toHaveTextContent("The shared summary was not written (the previous one stays).New 8 TB");
  });

  it("the switch asks the host to hide the layer", async () => {
    const { props, map } = setup({ on: false });
    expect(map.querySelector("[data-tg-group-frame]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Groups" }));
    expect(props.onToggle).toHaveBeenCalledWith(true);
  });
});

describe("multi-select on the map", () => {
  function selecting() {
    const selection = vi.fn((selected: readonly BranchView[], done: () => void) => (
      <button type="button" onClick={done}>
        Act on {selected.map((branch) => branch.lineId).join("+")}
      </button>
    ));
    return { ...setup({ selection }), selection };
  }

  it("a 多選 switch turns node clicks (and Enter / Space) into toggles; the host's actions get the selection", async () => {
    const { map } = selecting();
    const toggle = screen.getByRole("button", { name: "Select several" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(within(map).getByRole("button", { name: "disk-a, Brought back" })).not.toHaveAttribute("aria-pressed");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const a = within(map).getByRole("button", { name: "disk-a, Brought back" });
    expect(a).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(a);
    within(map).getByRole("button", { name: "router, Brought back" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(a).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Act on disk-a+router" }));
    // Done: the selection ends (interactions.md: multiselect → G → focused).
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("Esc on the map leaves multi-select; the main line is not selectable", async () => {
    const { map } = selecting();
    await userEvent.click(screen.getByRole("button", { name: "Select several" }));
    expect(within(map).getByRole("button", { name: /^Main line/ })).not.toHaveAttribute("aria-pressed");
    map.focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Select several" })).toHaveAttribute("aria-pressed", "false");
  });

  it("a viewer gets no 多選 (no selection actions given)", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Select several" })).toBeNull();
  });
});
