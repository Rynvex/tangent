/** 「已合併到…」 (B9 phase C `mergedIntoLineId`): the ended branch's bar, its outline row and its map node name where it went. */
import { normalizeBranchView } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchResultBar } from "../branch/branch-result-bar";
import { BranchMap } from "../structure/branch-map";
import { OutlineTree } from "../structure/outline-tree";

afterEach(cleanup);

const merged = normalizeBranchView({ lineId: "a", parentLineId: "root", rootLineId: "root", purpose: "Router A", status: "discarded", mergedIntoLineId: "n" });
const target = normalizeBranchView({ lineId: "n", parentLineId: "root", rootLineId: "root", purpose: "Pick the router", status: "open", origin: "merge" });

describe("combined branches say where they went", () => {
  it("the result bar names the new branch and goes there", async () => {
    const onShowMerged = vi.fn();
    render(<BranchResultBar branch={merged} mergedIntoTitle="Pick the router" onShowMerged={onShowMerged} />);
    expect(screen.getByRole("status")).toHaveTextContent("Combined into “Pick the router”.");
    await userEvent.click(screen.getByRole("button", { name: "Go to “Pick the router”" }));
    expect(onShowMerged).toHaveBeenCalled();
  });

  it("the outline row says it was combined into which branch", () => {
    render(<OutlineTree branches={[merged, target]} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    const row = screen.getByRole("treeitem", { name: /^Router A/ });
    expect(row).toHaveTextContent("Combined into “Pick the router”");
  });

  it("the map node too", () => {
    render(<BranchMap branches={[merged, target]} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    const map = screen.getByRole("group", { name: "Branch map" });
    expect(within(map).getByRole("button", { name: /^Router A/ }).textContent).toContain("Combined into “Pick the router”");
  });
});
