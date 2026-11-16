import { normalizeBranchPack, normalizeBranchView, normalizeMessage, type BranchView, type Message } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForkMarker } from "../conversation/fork-marker";
import { BranchBar } from "./branch-bar";
import { BranchResultBar } from "./branch-result-bar";
import { Breadcrumb } from "./breadcrumb";
import { KindRadio } from "./kind-radio";
import { zhTW } from "../i18n/zh-TW";

afterEach(cleanup);

const branch = (over: Record<string, unknown> = {}): BranchView =>
  normalizeBranchView({ lineId: "b1", parentLineId: "root", rootLineId: "root", anchorMessageId: "a1", depth: 1, purpose: "Rail passes", kind: "investigate", status: "open", ...over });
const msg = (id: string, role: string, seq: number, content = id): Message => normalizeMessage({ id, role, seq, lineId: "root", status: "done", content });
const parent = [msg("u1", "user", 1, "When should I go?"), msg("a1", "assistant", 2, "Autumn is lovely."), msg("u2", "user", 3, "And the food?")];

describe("KindRadio", () => {
  it("is a radio group with roving focus: arrows move and select, Home and End jump", async () => {
    const onValueChange = vi.fn();
    render(<KindRadio value="investigate" onValueChange={onValueChange} kinds={["aside", "investigate", "alternative"]} />);
    const group = screen.getByRole("radiogroup", { name: "Kind" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    radios[1]!.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenLastCalledWith("alternative");
    expect(radios[2]).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onValueChange).toHaveBeenLastCalledWith("aside");
    await userEvent.keyboard("{End}");
    expect(onValueChange).toHaveBeenLastCalledWith("alternative");
    await userEvent.click(screen.getByRole("radio", { name: /Aside/ }));
    expect(onValueChange).toHaveBeenLastCalledWith("aside");
  });

  it("only offers the kinds it is given (no aside when the feature is off)", () => {
    render(<KindRadio value="investigate" onValueChange={() => undefined} kinds={["investigate", "alternative"]} />);
    expect(screen.queryByRole("radio", { name: /Aside/ })).toBeNull();
  });
});

describe("ForkMarker inline list", () => {
  it("expands into the branches of the message and enters one", async () => {
    const onSelect = vi.fn();
    const closed = branch({ lineId: "b2", status: "discarded", purpose: "Used drives", conclusionLine: "Too expensive" });
    render(<ForkMarker branches={[branch({ unread: 2 }), closed]} onSelect={onSelect} />);
    const toggle = screen.getByRole("button", { name: /2 branches/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "Branches from this message" });
    expect(within(list).getByText("Too expensive")).toBeInTheDocument();
    expect(within(list).getByText("2 unread")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: /Rail passes/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ lineId: "b1" }));
  });

  it("says an aside is a one-turn leaf, not a branch left unbrought (F11 §1)", async () => {
    const aside = branch({ lineId: "b3", kind: "aside", status: "discarded", purpose: "What is ZFS" });
    render(<ForkMarker branches={[branch(), aside]} onSelect={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /2 branches/ }));
    const row = within(screen.getByRole("list", { name: "Branches from this message" })).getByRole("button", { name: /What is ZFS/ });
    expect(row.querySelector("[data-tg-fork-status]")).toHaveTextContent("Aside · single-turn leaf");
    expect(row).not.toHaveTextContent("Not brought back");
    expect(zhTW["fork.asideLeaf"]).toBe("順口問・單輪葉節點");
  });
});

describe("Breadcrumb", () => {
  it("links every level but the current one", async () => {
    const onSelect = vi.fn();
    render(<Breadcrumb items={[{ id: "root", label: "Main line" }, { id: "b1", label: "Rail passes", kind: "investigate" }]} onSelect={onSelect} />);
    const nav = screen.getByRole("navigation", { name: "Path" });
    expect(within(nav).getByText("Rail passes").closest("[aria-current]")).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(nav).getByRole("button", { name: "Main line" }));
    expect(onSelect).toHaveBeenCalledWith("root");
  });

  it("folds the middle levels when narrow", () => {
    const items = ["Main line", "One", "Two", "Three"].map((label, i) => ({ id: `l${i}`, label }));
    render(<Breadcrumb items={items} size="phone" onSelect={() => undefined} />);
    expect(screen.queryByText("One")).toBeNull();
    expect(screen.getByRole("button", { name: "…" })).toHaveAttribute("title", "One › Two");
  });
});

describe("BranchBar", () => {
  it("shows the leaf slot under an ended branch only (B1)", () => {
    const { rerender } = render(<BranchBar branch={branch({ status: "discarded" })} parentMessages={parent} onBack={() => undefined} onGoToFork={() => undefined} leaf={<p>the leaf</p>} />);
    expect(screen.getByText("the leaf")).toBeInTheDocument();
    rerender(<BranchBar branch={branch()} parentMessages={parent} onBack={() => undefined} onGoToFork={() => undefined} leaf={<p>the leaf</p>} />);
    expect(screen.queryByText("the leaf")).toBeNull();
  });

  const pack = normalizeBranchPack({ tokenEstimate: 2400, recent: [{ id: "u1" }, { id: "a1" }], rendered: "## Branch background", excerpt: "Autumn" });

  it("says where the branch came from, previews the fork point and goes back", async () => {
    const onBack = vi.fn();
    const onGoToFork = vi.fn();
    render(<BranchBar branch={branch({ excerpt: "Autumn" })} pack={pack} parentMessages={parent} onBack={onBack} onGoToFork={onGoToFork} />);
    const bar = screen.getByRole("region", { name: "Branch" });
    expect(bar).toHaveTextContent("You are in a branch");
    expect(bar).toHaveTextContent("Selected: “Autumn”");
    await userEvent.click(within(bar).getByRole("button", { name: "Main line" }));
    expect(onBack).toHaveBeenCalled();
    await userEvent.click(within(bar).getByRole("button", { name: "From main line #2" }));
    expect(onGoToFork).toHaveBeenCalledTimes(1);
    await userEvent.click(within(bar).getByRole("button", { name: "Preview the fork point" }));
    const peek = await screen.findByRole("dialog", { name: /Fork point #2/ });
    expect(within(peek).getByText("Autumn is lovely.").closest("[data-tg-peek-fork]")).not.toBeNull();
    expect(within(peek).getByText("When should I go?")).toBeInTheDocument();
    await userEvent.click(within(peek).getByRole("button", { name: "Go to that message →" }));
    expect(onGoToFork).toHaveBeenCalledTimes(2);
  });

  it("expands the background with its token estimate", async () => {
    render(<BranchBar branch={branch()} pack={pack} parentMessages={parent} onBack={() => undefined} onGoToFork={() => undefined} />);
    const toggle = screen.getByRole("button", { name: /Background ≈ 2.4k token/ });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("2 message(s) quoted up to the fork point")).toBeInTheDocument();
  });

  it("offers the endings of an open branch; promotion only on the main line", async () => {
    const onBringBack = vi.fn();
    const props = { parentMessages: parent, onBack: () => undefined, onGoToFork: () => undefined, onBringBack, onDiscard: () => undefined, onPromote: () => undefined };
    const { rerender } = render(<BranchBar branch={branch()} {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "End and bring back" }));
    expect(onBringBack).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Make main line" })).toBeInTheDocument();
    rerender(<BranchBar branch={branch({ parentLineId: "b0", depth: 2 })} {...props} />);
    expect(screen.queryByRole("button", { name: "Make main line" })).toBeNull();
    expect(screen.getByRole("button", { name: "Up one level" })).toBeInTheDocument();
    rerender(<BranchBar branch={branch({ status: "merged" })} {...props} />);
    expect(screen.queryByRole("button", { name: "End and bring back" })).toBeNull();
    rerender(<BranchBar branch={branch()} {...props} readOnly />);
    expect(screen.queryByRole("button", { name: "Don't bring back" })).toBeNull();
  });

  it("shows an aside's retention and the ways to keep it", async () => {
    const onKeep = vi.fn();
    const closedAt = "2026-01-01T00:00:00Z";
    render(
      <BranchBar
        branch={branch({ kind: "aside", status: "discarded", closedAt })}
        parentMessages={parent}
        now={Date.parse(closedAt) + 24 * 3600_000}
        onBack={() => undefined}
        onGoToFork={() => undefined}
        onKeepAsideAsNote={onKeep}
      />,
    );
    expect(screen.getByText("Cleared in 6 day(s)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save to notes" }));
    expect(onKeep).toHaveBeenCalled();
  });

  it("marks an aside as a one-turn leaf in words and a dashed frame (F11 §1)", () => {
    const props = { parentMessages: parent, onBack: () => undefined, onGoToFork: () => undefined };
    const { rerender } = render(<BranchBar branch={branch({ kind: "aside", status: "discarded", closedAt: "2026-01-01T00:00:00Z" })} {...props} />);
    const bar = screen.getByRole("region", { name: "Branch" });
    expect(bar).toHaveAttribute("data-tg-leaf-bar", "");
    expect(bar.className).toContain("outline-dashed");
    expect(bar.querySelector("[data-tg-leaf-hint]")).toHaveTextContent("Single-turn leaf (it ends after one answer; no branch can open below it)");
    expect(bar).not.toHaveTextContent("Not brought back");
    rerender(<BranchBar branch={branch({ kind: "aside", lineStatus: "thinking" })} {...props} />);
    expect(bar).toHaveTextContent("Answering");
    rerender(<BranchBar branch={branch()} {...props} />);
    expect(bar).not.toHaveAttribute("data-tg-leaf-bar");
    expect(bar.querySelector("[data-tg-leaf-hint]")).toBeNull();
    expect(bar).toHaveTextContent("Open");
    expect(zhTW["branch.asideLeafHint"]).toBe("單輪葉節點（一問一答即結束，不可往下開支線）");
  });
});

describe("BranchResultBar", () => {
  it("replaces the composer of an ended branch with its outcome", async () => {
    const onShowCard = vi.fn();
    const { rerender } = render(<BranchResultBar branch={branch({ status: "merged", cardMessageId: "c1" })} onShowCard={onShowCard} />);
    expect(screen.getByRole("status")).toHaveTextContent("Brought back to the main line.");
    await userEvent.click(screen.getByRole("button", { name: "See the card" }));
    expect(onShowCard).toHaveBeenCalled();
    rerender(<BranchResultBar branch={branch({ status: "discarded" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Ended without bringing anything back.");
    rerender(<BranchResultBar branch={branch({ status: "discarded", origin: "previous_main_line" })} />);
    expect(screen.getByRole("status")).toHaveTextContent("The main line before a promotion");
  });
});
