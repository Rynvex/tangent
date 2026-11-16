import { normalizeBranchView, type BranchView } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutlineTree, type OutlineTreeProps } from "./outline-tree";

afterEach(cleanup);

let seq = 0;
function view(id: string, extra: Record<string, unknown> = {}): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: "root", rootLineId: "root", purpose: id, status: "open", createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
}
const leaf = (kind: string) => ({ leaf: { kind, line: `${kind} line`, status: "confirmed" } });

// One open branch and seven ended ones: 2 decisions, 1 answer, 1 dead end, 3 without a leaf.
const BRANCHES = [
  view("open"),
  view("dec-1", { status: "merged", ...leaf("decision") }),
  view("dec-2", { status: "merged", ...leaf("decision") }),
  view("ans", { status: "merged", ...leaf("answer") }),
  view("dead", { status: "discarded", ...leaf("dead_end") }),
  view("oth-1", { status: "discarded" }),
  view("oth-2", { status: "discarded" }),
  view("oth-3", { status: "merged", ...leaf("to_continue") }),
];

function setup(props: Partial<OutlineTreeProps> = {}) {
  const onEnter = vi.fn();
  render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={onEnter} {...props} />);
  const tree = screen.getByRole("tree", { name: "Branch outline" });
  const row = (name: string | RegExp) => within(tree).getByRole("treeitem", { name: typeof name === "string" ? new RegExp(`^${name}(,|$)`) : name });
  const query = (name: string) => within(tree).queryByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
  return { onEnter, tree, row, query };
}

describe("OutlineTree: ended branches grouped by how they ended (F9 B.4)", () => {
  it("from six ended, shows one closed treeitem per kind with its count, then the toggle", () => {
    const { tree, row, query } = setup();
    const names = within(tree).getAllByRole("treeitem").map((item) => item.getAttribute("aria-label") ?? item.textContent?.split(",")[0]);
    expect(names.slice(2)).toEqual(["Decision: 2 ended branches", "Answer: 1 ended branches", "Dead end: 1 ended branches", "Other: 3 ended branches", "Show all 7 ended branches"]);
    const decision = row("Decision: 2 ended branches");
    expect(decision).toHaveAttribute("aria-expanded", "false");
    expect(decision).toHaveAttribute("aria-level", "2");
    expect(decision).toHaveAttribute("aria-posinset", "2");
    expect(decision).toHaveAttribute("aria-setsize", "6");
    expect(row("Show all 7 ended branches")).not.toHaveAttribute("aria-expanded");
    expect(query("dec-1")).toBeNull();
    expect(row("open")).toBeInTheDocument();
  });

  it("→ opens a group, ↓ reaches its branches, ← goes back up and closes it; Enter on a branch still enters it", async () => {
    const { row, query, onEnter } = setup();
    row("Main line").focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(row("Decision: 2 ended branches")).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(row("Decision: 2 ended branches")).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(row("dec-1")).toHaveFocus();
    expect(row("dec-1")).toHaveAttribute("aria-level", "3");
    await userEvent.keyboard("{Enter}");
    expect(onEnter).toHaveBeenLastCalledWith("dec-1");
    await userEvent.keyboard("{ArrowLeft}");
    expect(row("Decision: 2 ended branches")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(row("Decision: 2 ended branches")).toHaveAttribute("aria-expanded", "false");
    expect(query("dec-1")).toBeNull();
    // Enter toggles a group without entering anything.
    await userEvent.keyboard("{Enter}");
    expect(row("Decision: 2 ended branches")).toHaveAttribute("aria-expanded", "true");
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("Enter on the toggle shows every ended branch in line, and again groups them; focus stays on the toggle", async () => {
    const { row, query, onEnter } = setup();
    row("Main line").focus();
    await userEvent.keyboard("{End}");
    expect(row("Show all 7 ended branches")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(row("dec-1")).toBeInTheDocument();
    expect(query("Decision: 2 ended branches")).toBeNull();
    const toggle = row("Group the ended branches by how they ended");
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-posinset", "9");
    await userEvent.click(toggle);
    expect(query("dec-1")).toBeNull();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("keeps the line on screen reachable: its group opens by itself, and closes when the reader closes it", async () => {
    const { row, query } = setup({ currentLineId: "oth-2" });
    expect(row("Other: 3 ended branches")).toHaveAttribute("aria-expanded", "true");
    expect(row("oth-2")).toHaveAttribute("aria-current", "location");
    expect(row("oth-2")).toHaveAttribute("tabindex", "0");
    row("oth-2").focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(row("Other: 3 ended branches")).toHaveAttribute("aria-expanded", "false");
    expect(query("oth-2")).toBeNull();
  });

  it("finds a group by typing its name", async () => {
    const { row } = setup();
    row("Main line").focus();
    await userEvent.keyboard("ot");
    expect(row("Other: 3 ended branches")).toHaveFocus();
  });

  it("keeps five ended branches in line, with no groups and no toggle", () => {
    const { tree } = setup({ branches: BRANCHES.filter((branch) => !["oth-1", "oth-2"].includes(branch.lineId)) });
    expect(within(tree).queryByRole("treeitem", { name: /ended branches/ })).toBeNull();
    expect(within(tree).getAllByRole("treeitem")).toHaveLength(7);
  });
});
