import { normalizeBranchView, normalizeMessage, type Message } from "@tangent/client";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { BranchCard } from "./branch-card";

afterEach(cleanup);

const card = {
  question: "Mirror or RAIDZ1?",
  conclusion: "Both survive one failed disk.",
  evidence: [{ messageId: "b-2", note: "Degraded mode needs a manual mount" }],
  impact: "Use a ZFS mirror.",
  openItems: ["Is ECC needed?"],
  needsDecision: [{ branchClaim: "Two big disks", mainLineClaim: "Four disks in RAIDZ1", mainLineMessageId: "m18" }],
  excerpts: [{ messageId: "b-2", text: "zpool create tank mirror" }],
};
const message = (meta: Record<string, unknown> = {}): Message =>
  normalizeMessage({ id: "c1", seq: 24, lineId: "root", role: "system", kind: "branch_card", status: "done", content: "x", meta: { card, branchLineId: "b1", ...meta } });
const branch = normalizeBranchView({ lineId: "b1", parentLineId: "root", rootLineId: "root", anchorMessageId: "m17", purpose: "ZFS or Btrfs", status: "merged" });
const numbers = new Map([
  ["m17", 17],
  ["m18", 18],
]);

describe("BranchCard", () => {
  it("shows the purpose, the conclusion and what needs a decision while folded", async () => {
    const onGoToMessage = vi.fn();
    render(<BranchCard message={message()} branch={branch} mainNumbers={numbers} onGoToMessage={onGoToMessage} onOpenBranch={() => undefined} />);
    const region = screen.getByRole("region", { name: "Conclusion card" });
    expect(region).toHaveTextContent("ZFS or Btrfs");
    expect(region).toHaveTextContent("Both survive one failed disk.");
    expect(within(region).getByText("Needs your decision")).toBeInTheDocument();
    expect(region).toHaveTextContent("Two big disks");
    expect(region).not.toHaveTextContent("Mirror or RAIDZ1?");
    await userEvent.click(within(region).getByRole("button", { name: /Main line #18 says/ }));
    expect(onGoToMessage).toHaveBeenCalledWith("m18");
  });

  it("marks a card the AI has not heard about yet, and one it has", () => {
    const { rerender } = render(<BranchCard message={message()} branch={branch} />);
    expect(screen.getByText("The AI hears about it next turn")).toBeInTheDocument();
    rerender(<BranchCard message={message({ delivered: true })} branch={branch} />);
    expect(screen.queryByText("The AI hears about it next turn")).toBeNull();
    expect(screen.getByText("Told the AI")).toBeInTheDocument();
  });

  it("says a card an import wrote was made by the import, and when (F14 S4b)", async () => {
    // Arrange
    const imported = normalizeBranchView({ ...branch, origin: "import" });
    const at = new Date(2026, 7, 12, 15, 22).toISOString();
    const written = normalizeMessage({ ...message({ delivered: true }), createdAt: at });
    // Act
    const { rerender } = render(<BranchCard message={written} branch={imported} />);
    // Assert
    expect(document.querySelector('[data-tg-card-state="imported"]')).toHaveTextContent(/^From import · 08\/12 15:22$/);
    expect(document.querySelector('[data-tg-card-state="imported"] time')).toHaveAttribute("datetime", at);
    expect(screen.queryByText("Told the AI")).toBeNull();
    rerender(<BranchCard message={written} branch={branch} />);
    expect(screen.getByText("Told the AI")).toBeInTheDocument();
    cleanup();
    const client = mockClient();
    render(<BranchCard message={written} branch={imported} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    await waitFor(() => expect(document.querySelector('[data-tg-card-state="imported"]')).toHaveTextContent(/^匯入時建立・08\/12 15:22$/));
    client.mock.dispose();
  });

  it("expands every field and links to the branch, its evidence and the fork point", async () => {
    const onOpenBranch = vi.fn();
    const onGoToMessage = vi.fn();
    render(<BranchCard message={message()} branch={branch} mainNumbers={numbers} onOpenBranch={onOpenBranch} onGoToMessage={onGoToMessage} />);
    const toggle = screen.getByRole("button", { name: "Show all fields" });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const region = screen.getByRole("region", { name: "Conclusion card" });
    for (const text of ["Mirror or RAIDZ1?", "Use a ZFS mirror.", "Is ECC needed?", "zpool create tank mirror", "Degraded mode needs a manual mount"]) {
      expect(region).toHaveTextContent(text);
    }
    await userEvent.click(within(region).getByRole("button", { name: "Open evidence 1 in the branch" }));
    expect(onOpenBranch).toHaveBeenLastCalledWith("b1", "b-2");
    await userEvent.click(within(region).getByRole("button", { name: "See the branch" }));
    expect(onOpenBranch).toHaveBeenLastCalledWith("b1", undefined);
    await userEvent.click(within(region).getByRole("button", { name: "Fork point #17" }));
    expect(onGoToMessage).toHaveBeenCalledWith("m17");
  });
});

describe("BranchCard: the leaf is its title row (B1, handoff §9-4)", () => {
  it("uses the branch's leaf kind and line when leaves are on", () => {
    const decided = normalizeBranchView({ ...branch, leaf: { kind: "decision", line: "Go with a ZFS mirror", status: "confirmed" } });
    render(<BranchCard message={message()} branch={decided} showLeaf />);
    const region = screen.getByRole("region", { name: "Conclusion card" });
    const leaf = region.querySelector('[data-tg-leaf="decision"]');
    expect(leaf).not.toBeNull();
    expect(leaf).toHaveTextContent("Go with a ZFS mirror");
  });

  it("keeps the card's conclusion with the conclusion flag otherwise", () => {
    const decided = normalizeBranchView({ ...branch, leaf: { kind: "decision", line: "Go with a ZFS mirror", status: "confirmed" } });
    render(<BranchCard message={message()} branch={decided} />);
    const region = screen.getByRole("region", { name: "Conclusion card" });
    expect(region.querySelector("[data-tg-leaf]")).toBeNull();
    expect(region).toHaveTextContent("Both survive one failed disk.");
  });
});

