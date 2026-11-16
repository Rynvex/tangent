import { normalizeBranchView, type BranchView } from "@tangent/client";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zhTW } from "../i18n/zh-TW";
import { OutlineTree, type OutlineTreeProps } from "./outline-tree";

afterEach(cleanup);

let seq = 0;
function view(id: string, parent: string, extra: Record<string, unknown> = {}): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: id, status: "open", createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`, ...extra });
}

const BRANCHES = [
  view("alpha", "root", { unread: 2 }),
  view("alpha-one", "alpha", { lineStatus: "thinking" }),
  view("alpha-two", "alpha", { status: "discarded", conclusionLine: "Too pricey" }),
  view("bee", "root", { kind: "aside", status: "merged" }),
  view("cedar", "root"),
];

function setup(props: Partial<OutlineTreeProps> = {}) {
  const onEnter = vi.fn();
  const onEscape = vi.fn();
  render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="alpha" mainCount={33} onEnter={onEnter} onEscape={onEscape} {...props} />);
  const tree = screen.getByRole("tree", { name: "Branch outline" });
  // A row's name is its title then its state ("alpha, Open, 2 unread").
  const row = (name: string) => within(tree).getByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
  return { onEnter, onEscape, tree, row };
}

describe("OutlineTree: structure and ARIA (interactions.md A8)", () => {
  it("is one tree with levels, set sizes and positions; the current row is the location and the only tab stop", () => {
    const { tree, row } = setup();
    const rows = within(tree).getAllByRole("treeitem");
    // F11 §1: the aside (bee) shows by default, as a leaf among the main line's branches.
    expect(rows.map((item) => [item.getAttribute("aria-level"), item.getAttribute("aria-posinset"), item.getAttribute("aria-setsize")])).toEqual([
      ["1", "1", "1"],
      ["2", "1", "3"],
      ["3", "1", "2"],
      ["3", "2", "2"],
      ["2", "2", "3"],
      ["2", "3", "3"],
    ]);
    expect(row("alpha")).toHaveAttribute("aria-current", "location");
    expect(row("alpha")).toHaveAttribute("aria-expanded", "true");
    expect(rows.filter((item) => item.tabIndex === 0)).toEqual([row("alpha")]);
    expect(row("Main line")).toHaveTextContent("33 messages");
    expect(row("alpha")).toHaveTextContent("You are here");
  });

  it("describes a replying row without taking focus, and shows asides as leaves until hidden (F11 §1)", async () => {
    const { tree, row } = setup();
    expect(row("alpha-one")).toHaveAccessibleDescription("Replying");
    expect(row("bee")).toHaveAccessibleName("bee, Single-turn leaf");
    await userEvent.click(screen.getByRole("button", { name: "Hide asides (1)" }));
    expect(within(tree).queryByRole("treeitem", { name: /^bee,/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show asides (1)" }));
    expect(row("bee")).toBeInTheDocument();
  });

  it("says 回答中 on an aside while it answers, without a second replying line", () => {
    const { row } = setup({ branches: [...BRANCHES.filter((branch) => branch.lineId !== "bee"), view("bee", "root", { kind: "aside", status: "open", lineStatus: "thinking" })] });
    expect(row("bee")).toHaveAccessibleName("bee, Answering");
    expect(row("bee")).not.toHaveAccessibleDescription("Replying");
    expect(row("bee").querySelector("[data-tg-status]")).toHaveTextContent("Answering");
  });

  it("keeps the open status on an aside whose answer has not come (a failed turn to retry)", () => {
    const { row } = setup({ branches: [...BRANCHES.filter((branch) => branch.lineId !== "bee"), view("bee", "root", { kind: "aside", status: "open", lineStatus: "error" })] });
    expect(row("bee")).not.toHaveAccessibleName(/Single-turn leaf/);
  });

  it("words the toggle and the leaf status in Traditional Chinese", () => {
    expect([zhTW["outline.showAsides"], zhTW["outline.hideAsides"], zhTW["branch.asideLeaf"]]).toEqual(["顯示順口問（{count}）", "隱藏順口問（{count}）", "單輪葉節點"]);
  });

  it("falls back to the main line as the tab stop on the main line", () => {
    const { row } = setup({ currentLineId: "root" });
    expect(row("Main line")).toHaveAttribute("tabindex", "0");
    expect(row("Main line")).toHaveAttribute("aria-current", "location");
  });
});

describe("OutlineTree: keys", () => {
  it("moves with arrows, Home and End, opens and closes rows with → and ←", async () => {
    const { row } = setup();
    row("alpha").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(row("alpha-one")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(row("alpha")).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(row("alpha")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /^alpha-one,/ })).toBeNull();
    await userEvent.keyboard("{ArrowRight}");
    expect(row("alpha")).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(row("alpha-one")).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(row("cedar")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(row("Main line")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(row("Main line")).toHaveFocus();
  });

  it("enters a row with Enter or Space (focus stays), the main line by its id", async () => {
    const { row, onEnter } = setup();
    row("cedar").focus();
    await userEvent.keyboard("{Enter}");
    expect(onEnter).toHaveBeenLastCalledWith("cedar");
    expect(row("cedar")).toHaveFocus();
    await userEvent.keyboard("{Home}{ }");
    expect(onEnter).toHaveBeenLastCalledWith("root");
  });

  it("jumps by typed text and expands every sibling with *", async () => {
    const { row } = setup();
    row("alpha").focus();
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("c");
    expect(row("cedar")).toHaveFocus();
    await userEvent.keyboard("*");
    expect(row("alpha")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows both the fold chevron and the checkbox on a row with children in multiselect", async () => {
    const { row } = setup({ selectionActions: () => null });
    expect(row("alpha").querySelector("[data-tg-check]")).toBeNull();
    row("alpha").focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    const parent = row("alpha");
    expect(parent.querySelector("[data-tg-fold]")).not.toBeNull();
    expect(parent.querySelector("[data-tg-check]")).toHaveAttribute("data-checked");
    expect(row("cedar").querySelector("[data-tg-check]")).not.toHaveAttribute("data-checked");
  });

  it("moves the tab stop to the new current line after navigating elsewhere, unless focus is in the tree", async () => {
    const onEnter = vi.fn();
    const props = { branches: BRANCHES, rootLineId: "root", mainCount: 3, onEnter };
    const { rerender } = render(<OutlineTree {...props} currentLineId="alpha" />);
    const tree = screen.getByRole("tree", { name: "Branch outline" });
    const row = (name: string) => within(tree).getByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
    // Elsewhere (breadcrumb, fork marker, shortcut): Tab lands on "you are here".
    rerender(<OutlineTree {...props} currentLineId="cedar" />);
    expect(row("cedar")).toHaveAttribute("tabindex", "0");
    expect(row("alpha")).toHaveAttribute("tabindex", "-1");
    await userEvent.tab();
    expect(row("cedar")).toHaveFocus();
    // From inside the tree, the row the reader is on keeps focus.
    await userEvent.keyboard("{ArrowUp}");
    const focused = document.activeElement;
    act(() => rerender(<OutlineTree {...props} currentLineId="alpha-one" />));
    expect(document.activeElement).toBe(focused);
    expect(focused).toHaveAttribute("tabindex", "0");
  });

  it("selects several with Shift+arrows, all with ⌘A, and clears with Esc", async () => {
    const { tree, row } = setup({ selectionActions: () => null });
    row("alpha").focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(tree).toHaveAttribute("aria-multiselectable", "true");
    expect(row("alpha")).toHaveAttribute("aria-selected", "true");
    expect(row("alpha-one")).toHaveAttribute("aria-selected", "true");
    expect(row("cedar")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    await userEvent.keyboard("{Control>}a{/Control}");
    expect(screen.getByText("4 selected")).toBeInTheDocument();
    expect(row("Main line")).not.toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ }");
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(tree).not.toHaveAttribute("aria-multiselectable");
    expect(row("alpha-one")).not.toHaveAttribute("aria-selected");
  });

  it("R9 G2: with no selection actions (group off, read-only) there is no 多選: no button, Shift+arrows only move, Shift-click enters", async () => {
    const { tree, row, onEnter } = setup();
    expect(screen.queryByRole("button", { name: "Select several" })).toBeNull();
    row("alpha").focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(tree).not.toHaveAttribute("aria-multiselectable");
    expect(row("alpha-one")).toHaveFocus();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}");
    await user.click(row("cedar"));
    await user.keyboard("{/Shift}");
    expect(tree).not.toHaveAttribute("aria-multiselectable");
    expect(onEnter).toHaveBeenCalledWith("cedar");
  });

  it("the selection bar carries the host's actions; G runs the group action (interactions.md multiselect → G)", async () => {
    const onSelectionKey = vi.fn();
    const selectionActions = vi.fn((selected: readonly BranchView[], done: () => void) => (
      <button type="button" onClick={done}>
        Group {selected.map((branch) => branch.lineId).join("+")}
      </button>
    ));
    const { tree, row } = setup({ selectionActions, onSelectionKey });
    expect(screen.queryByRole("button", { name: /^Group/ })).toBeNull();
    row("alpha").focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(screen.getByRole("button", { name: "Group alpha+alpha-one" })).toBeInTheDocument();
    row("alpha-one").focus();
    await userEvent.keyboard("g");
    expect(onSelectionKey).toHaveBeenCalledWith([expect.objectContaining({ lineId: "alpha" }), expect.objectContaining({ lineId: "alpha-one" })], expect.any(Function));
    // Not a typeahead jump while selecting.
    expect(row("alpha-one")).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Group alpha+alpha-one" }));
    expect(tree).not.toHaveAttribute("aria-multiselectable");
  });

  it("D2: with argument tags shown, a branch names the type of the message it forks from", () => {
    const tagged = [view("tagged", "root", { anchorTag: { kind: "question", source: "user", status: "confirmed", updatedAt: "" } }), view("plain", "root")];
    render(<OutlineTree branches={tagged} rootLineId="root" currentLineId="root" onEnter={vi.fn()} showTags />);
    const tree = screen.getByRole("tree", { name: "Branch outline" });
    expect(within(tree).getByRole("treeitem", { name: /^tagged, Open, forks from a Question$/ })).toHaveTextContent("Question");
    expect(within(tree).getByRole("treeitem", { name: /^plain, Open$/ })).not.toHaveTextContent("Question");
    cleanup();
    render(<OutlineTree branches={tagged} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    expect(screen.getByRole("treeitem", { name: /^tagged, Open$/ })).not.toHaveTextContent("Question");
  });

  it("renames an open branch with F2: empty is refused, Enter saves, Esc gives up", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const { row } = setup({ onRename });
    row("cedar").focus();
    await userEvent.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "New purpose" });
    expect(input).toHaveFocus();
    await userEvent.clear(input);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("A purpose is required.")).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
    await userEvent.type(input, "Cedar wood{Enter}");
    expect(onRename).toHaveBeenCalledWith("cedar", "Cedar wood");
    expect(screen.queryByRole("textbox", { name: "New purpose" })).toBeNull();
    expect(row("cedar")).toHaveFocus();
    await userEvent.keyboard("{F2}");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "New purpose" })).toBeNull();
    // B13: an ended branch can be renamed too.
    row("alpha-two").focus();
    await userEvent.keyboard("{F2}");
    expect(screen.getByRole("textbox", { name: "New purpose" })).toHaveValue("alpha-two");
    await userEvent.keyboard("{Escape}");
  });

  it("keeps a promoted branch and the previous main line as they are (B13)", async () => {
    const promoted = [view("moved", "root", { status: "promoted" }), view("old-main", "root", { status: "discarded", origin: "previous_main_line" })];
    const onRename = vi.fn(() => Promise.resolve());
    render(<OutlineTree branches={promoted} rootLineId="root" currentLineId="root" mainCount={1} onEnter={vi.fn()} onRename={onRename} />);
    for (const name of [/^moved/, /previous main line|原本的主線/i]) {
      const target = screen.getAllByRole("treeitem").find((item) => name.test(item.textContent ?? ""));
      expect(target).toBeDefined();
      target!.focus();
      await userEvent.keyboard("{F2}");
      expect(screen.queryByRole("textbox", { name: "New purpose" })).toBeNull();
    }
  });

  it("hands Esc back to the host (focus to the composer) when nothing else takes it", async () => {
    const { row, onEscape } = setup();
    row("alpha").focus();
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalled();
  });
});

describe("OutlineTree: leaves (B1)", () => {
  const withLeaf = [view("dead", "root", { status: "discarded", conclusionLine: "Old line", leaf: { kind: "dead_end", line: "Too pricey", status: "draft" } })];

  it("shows a branch's leaf as the row's last line, and names it, when leaves are on", () => {
    render(<OutlineTree branches={withLeaf} rootLineId="root" currentLineId="root" onEnter={vi.fn()} showLeaves />);
    const row = screen.getByRole("treeitem", { name: /^dead,/ });
    expect(row.getAttribute("aria-label")).toContain("Dead end: Too pricey");
    expect(row.querySelector('[data-tg-leaf="dead_end"]')?.getAttribute("data-leaf-state")).toBe("draft");
    expect(row).not.toHaveTextContent("Old line");
  });

  it("renders no leaf while the leaf feature is off (the old conclusion line stays)", () => {
    render(<OutlineTree branches={withLeaf} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    const row = screen.getByRole("treeitem", { name: /^dead,/ });
    expect(row.querySelector("[data-tg-leaf]")).toBeNull();
    expect(row).toHaveTextContent("Old line");
  });
});

