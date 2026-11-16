/** The map's 論證類型 layer (D2, handoff §9-7: label = argument type). */
import { normalizeBranchView } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap } from "./branch-map";

afterEach(cleanup);

const BRANCHES = [
  normalizeBranchView({ lineId: "q", parentLineId: "root", rootLineId: "root", purpose: "q", status: "merged", anchorTag: { kind: "question", source: "user", status: "confirmed", updatedAt: "" } }),
  normalizeBranchView({ lineId: "plain", parentLineId: "root", rootLineId: "root", purpose: "plain", status: "merged" }),
];

describe("argument type layer", () => {
  it("is offered only with the ibis feature (the host gives it); off by the switch, no labels", async () => {
    const onToggle = vi.fn();
    render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} tags={{ on: false, onToggle }} />);
    const map = screen.getByRole("group", { name: "Branch map" });
    expect(within(map).getByRole("button", { name: "q, Brought back" })).not.toHaveTextContent("Question");
    await userEvent.click(within(screen.getByRole("group", { name: "Map layers" })).getByRole("button", { name: "Argument types" }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("on: a node shows the type of the message it forks from, and says it", () => {
    render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} tags={{ on: true, onToggle: vi.fn() }} />);
    const map = screen.getByRole("group", { name: "Branch map" });
    expect(within(map).getByRole("button", { name: "q, Brought back, forks from a Question" })).toHaveTextContent("Question");
    expect(within(map).getByRole("button", { name: "plain, Brought back" })).toBeInTheDocument();
  });

  it("is absent without the feature", () => {
    render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Map layers" })).toBeNull();
  });
});
