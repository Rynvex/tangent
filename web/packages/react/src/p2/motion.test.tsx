/** Reduced motion (components.md 通用狀態): the P2 parts animate only through the motion tokens, which reduced motion zeroes. */
import { normalizeBranchView, normalizeSuggestion } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap } from "../structure/branch-map";
import { mockClient, tangentWrapper } from "../test-utils";
import { DriftHint } from "./drift-hint";
import { GoalCapsule } from "./goal-capsule";
import { RelationList } from "./relation-list";

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function expectMotionTokensOnly(html: string): void {
  expect(html).not.toMatch(/(?<!motion-safe:)animate-/);
  for (const match of html.match(/duration-[^\s"]+/g) ?? []) expect(match).toMatch(/^duration-\(--tg-duration-(fast|normal)\)$/);
}

describe("P2 parts and reduced motion", () => {
  it("the goal capsule, the drift hint and the relation list", async () => {
    const client = mockClient();
    clients.push(client);
    await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3" });
    const drift = normalizeSuggestion({ id: "d", feature: "goal", kind: "drift", status: "open", payload: { anchorMessageId: "nas-m17", kind: "investigate" } });
    const { container } = render(
      <>
        <GoalCapsule rootLineId={NAS_ROOT_ID} />
        <DriftHint rootLineId={NAS_ROOT_ID} suggestion={drift} onOpened={vi.fn()} />
        <RelationList rootLineId={NAS_ROOT_ID} onGo={vi.fn()} onAdd={vi.fn()} />
      </>,
      { wrapper: tangentWrapper(client) },
    );
    await screen.findByRole("button", { name: /^Goal: / });
    await screen.findByRole("listitem");
    expectMotionTokensOnly(container.outerHTML);
  });

  it("the map's relation and fisheye layers", () => {
    const branches = ["a", "b"].map((id) => normalizeBranchView({ lineId: id, parentLineId: "root", rootLineId: "root", purpose: id, status: "open" }));
    const relation = { id: "r", kind: "relation" as const, fromLineId: "a", fromMessageId: "", toLineId: "b", toMessageId: "", label: "x", fromTitle: "a", toTitle: "b", createdBy: "", createdAt: "" };
    const noop = async () => undefined;
    const { container } = render(
      <BranchMap
        branches={branches}
        rootLineId="root"
        currentLineId="root"
        onEnter={vi.fn()}
        relations={{ relations: [relation], suggestions: [], readOnly: false, onCreate: async () => relation, onUpdateLabel: noop, onDelete: noop, onUndoDelete: noop, onAccept: noop, onDismiss: noop, describeFailure: () => "" }}
        fisheye={{ on: true, onToggle: vi.fn(), levels: new Map([["a", "hidden"], ["b", "leaf_only"]]) }}
      />,
    );
    expectMotionTokensOnly(container.outerHTML);
  });
});
