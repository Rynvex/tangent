import { normalizeBranchView, type MapNode } from "@tangent/client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zhTW } from "../i18n/zh-TW";
import { MapNodeView } from "./map-node";

afterEach(cleanup);

function node(kind: "aside" | "investigate", extra: Record<string, unknown> = {}): MapNode {
  const branch = normalizeBranchView({ lineId: `${kind}-1`, parentLineId: "root", rootLineId: "root", purpose: `What is ${kind}`, status: "discarded", kind, createdAt: "2026-01-01T00:00:00Z", ...extra });
  // A node with children, so the fold toggle would show for any other branch.
  return { key: branch.lineId, branch, x: 0, y: 0, width: 188, height: 60, hasChildren: true, collapsed: false, hiddenCount: 0 } as unknown as MapNode;
}

function renderNode(target: MapNode) {
  const { container } = render(<MapNodeView node={target} isCurrent={false} onPath={false} mainCount={3} zoom={1} onEnter={vi.fn()} onToggleFold={vi.fn()} onConnectStart={vi.fn()} />);
  return container.querySelector(`[data-tg-map-node="${target.key}"]`) as HTMLElement;
}

describe("MapNodeView: an aside is a terminal leaf (F11 §1)", () => {
  it("draws an aside as a dashed, rounded leaf with the leaf mark and the one-turn line; no relation handle, no fold toggle", () => {
    const element = renderNode(node("aside"));
    expect(element).toHaveAttribute("data-tg-leaf-node", "");
    const button = screen.getByRole("button", { name: "What is aside, Single-turn leaf" });
    expect(button.className).toContain("border-dashed");
    expect(button.className).toContain("bg-tg-surface-sunken");
    expect(element.querySelector("[data-tg-leaf-mark]")).toHaveTextContent("Single-turn leaf");
    expect(element).toHaveTextContent("One question, one answer · no further branches");
    expect(element).not.toHaveTextContent("Not brought back");
    expect(element.querySelector("[data-tg-connector]")).toBeNull();
    expect(screen.queryByRole("button", { name: /Fold the branches/ })).toBeNull();
  });

  it("shows an aside's answer summary when it has one, and Answering while it answers", () => {
    renderNode(node("aside", { conclusionLine: "A cache layer", status: "open", lineStatus: "thinking" }));
    expect(screen.getByRole("button", { name: "What is aside, Answering" })).toHaveTextContent("A cache layer");
  });

  it("words the leaf in Traditional Chinese", () => {
    expect([zhTW["branch.asideLeaf"], zhTW["branch.asideLeafNote"], zhTW["branch.asideAnswering"]]).toEqual(["單輪葉節點", "單輪問答・不往下分岔", "回答中"]);
  });

  it("keeps an investigate branch a solid card with its status, relation handle and fold toggle", () => {
    const element = renderNode(node("investigate"));
    expect(element).not.toHaveAttribute("data-tg-leaf-node");
    const button = screen.getByRole("button", { name: "What is investigate, Not brought back" });
    expect(button.className).not.toContain("border-dashed");
    expect(button.className).toContain("bg-tg-surface");
    expect(element.querySelector("[data-tg-leaf-mark]")).toBeNull();
    expect(element.querySelector("[data-tg-connector]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Fold the branches/ })).toBeInTheDocument();
  });
});
