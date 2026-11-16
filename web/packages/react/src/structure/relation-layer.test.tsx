/** The map's relation layer (C3, interactions.md 「地圖拉關聯線」): drawing, the layer switch, drag and keyboard linking. */
import { normalizeBranchView, normalizeSuggestion, type BranchView, type Link } from "@tangent/client";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap, type MapRelationsProps } from "./branch-map";

afterEach(cleanup);

const view = (id: string, parent: string, at: number): BranchView =>
  normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: id, status: "open", createdAt: `2026-01-01T00:00:0${at}Z` });
const BRANCHES = [view("alpha", "root", 1), view("beta", "root", 2), view("gamma", "root", 3)];

const link = (over: Partial<Link>): Link => ({
  id: "r1",
  kind: "relation",
  fromLineId: "alpha",
  fromMessageId: "",
  toLineId: "beta",
  toMessageId: "",
  label: "same budget",
  fromTitle: "alpha",
  toTitle: "beta",
  createdBy: "",
  createdAt: "",
  ...over,
});

function setup(over: Partial<MapRelationsProps> = {}) {
  const relations: MapRelationsProps = {
    relations: [link({})],
    suggestions: [],
    readOnly: false,
    onCreate: vi.fn(async (fromLineId: string, toLineId: string) => link({ id: "new", fromLineId, toLineId, label: "" })),
    onUpdateLabel: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
    onUndoDelete: vi.fn(async () => undefined),
    onAccept: vi.fn(async () => undefined),
    onDismiss: vi.fn(async () => undefined),
    describeFailure: () => "failed",
    ...over,
  };
  const onEnter = vi.fn();
  render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={onEnter} relations={relations} />);
  const map = screen.getByRole("group", { name: "Branch map" });
  return { map, relations, onEnter };
}

/** A node's top-left in layout pixels (zoom 100 %, nothing scrolled; jsdom puts the canvas at 0,0). */
function corner(map: HTMLElement, key: string) {
  const node = map.querySelector<HTMLElement>(`[data-tg-map-node="${key}"]`)!;
  return { x: parseFloat(node.style.left), y: parseFloat(node.style.top) };
}

describe("relation layer", () => {
  it("draws a relation between two nodes with its note, under a 關聯 layer switch", async () => {
    const { map } = setup();
    expect(map.querySelectorAll("path[data-tg-relation]")).toHaveLength(1);
    expect(within(map).getByRole("button", { name: "Relation alpha – beta: same budget" })).toBeInTheDocument();
    const layers = screen.getByRole("group", { name: "Map layers" });
    const toggle = within(layers).getByRole("button", { name: "Relations" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(map.querySelectorAll("path[data-tg-relation]")).toHaveLength(0);
    expect(map.querySelectorAll("[data-tg-connector]")).toHaveLength(0);
  });

  it("keyboard: R on a node, arrows choose the other end, Enter makes it, then the note and Enter", async () => {
    const { map, relations, onEnter } = setup({ relations: [] });
    within(map).getByRole("button", { name: /^alpha/ }).focus();
    await userEvent.keyboard("r");
    expect(screen.getByRole("status", { name: "Relation status" })).toHaveTextContent("Relating “alpha”");
    await userEvent.keyboard("{ArrowDown}");
    const target = document.activeElement as HTMLElement;
    expect(target.closest("[data-tg-map-node]")).not.toBeNull();
    expect(target.closest("[data-tg-map-node]")?.getAttribute("data-tg-map-node")).not.toBe("alpha");
    await userEvent.keyboard("{Enter}");
    expect(onEnter).not.toHaveBeenCalled();
    // The relation exists from here (interactions.md: Enter 建立關聯, then the note).
    await waitFor(() => expect(relations.onCreate).toHaveBeenCalledWith("alpha", expect.any(String)));
    const note = screen.getByRole("textbox", { name: "What connects them" });
    expect(note).toHaveFocus();
    await userEvent.type(note, "same disks{Enter}");
    await waitFor(() => expect(relations.onUpdateLabel).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }), "same disks"));
  });

  it("Esc while choosing cancels; Esc while writing the note keeps the relation without one", async () => {
    const { map, relations } = setup({ relations: [] });
    within(map).getByRole("button", { name: /^alpha/ }).focus();
    await userEvent.keyboard("r{Escape}");
    expect(screen.getByRole("status", { name: "Relation status" })).toHaveTextContent("");
    within(map).getByRole("button", { name: /^alpha/ }).focus();
    await userEvent.keyboard("r{ArrowDown}{Enter}");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(relations.onCreate).toHaveBeenCalledWith("alpha", expect.any(String)));
    expect(relations.onUpdateLabel).not.toHaveBeenCalled();
  });

  it("drag from a node's right dot onto another node, then write the note", async () => {
    const { map, relations } = setup({ relations: [] });
    const connector = map.querySelector<HTMLElement>('[data-tg-connector="alpha"]')!;
    const gamma = corner(map, "gamma");
    fireEvent.pointerDown(connector, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    const canvas = map;
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: gamma.x + 20, clientY: gamma.y + 20 });
    expect(map.querySelector("[data-tg-drag-line]")).not.toBeNull();
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: gamma.x + 20, clientY: gamma.y + 20 });
    await waitFor(() => expect(relations.onCreate).toHaveBeenCalledWith("alpha", "gamma"));
    const note = await screen.findByRole("textbox", { name: "What connects them" });
    await userEvent.type(note, "x{Enter}");
    await waitFor(() => expect(relations.onUpdateLabel).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }), "x"));
  });

  it("a second finger (a pinch) or a cancelled pointer ends a drag without a relation (F9)", async () => {
    const { map, relations } = setup({ relations: [] });
    const connector = map.querySelector<HTMLElement>('[data-tg-connector="alpha"]')!;
    const gamma = corner(map, "gamma");
    const onGamma = { clientX: gamma.x + 20, clientY: gamma.y + 20 };
    fireEvent.pointerDown(connector, { button: 0, pointerId: 1, pointerType: "touch" });
    fireEvent.pointerMove(map, { pointerId: 1, ...onGamma });
    fireEvent.pointerDown(map, { button: 0, pointerId: 2, pointerType: "touch", clientX: 5, clientY: 5 });
    expect(map.querySelector("[data-tg-drag-line]")).toBeNull();
    fireEvent.pointerUp(map, { pointerId: 2, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(map, { pointerId: 1, ...onGamma });
    fireEvent.pointerDown(connector, { button: 0, pointerId: 3 });
    fireEvent.pointerMove(map, { pointerId: 3, ...onGamma });
    fireEvent.pointerCancel(map, { pointerId: 3 });
    expect(map.querySelector("[data-tg-drag-line]")).toBeNull();
    fireEvent.pointerUp(map, { pointerId: 3, ...onGamma });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(relations.onCreate).not.toHaveBeenCalled();
  });

  it("a drop on empty canvas, on the node itself or on one already related cancels", async () => {
    const { map, relations } = setup();
    const connector = map.querySelector<HTMLElement>('[data-tg-connector="alpha"]')!;
    const beta = corner(map, "beta");
    fireEvent.pointerDown(connector, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(map, { pointerId: 1, clientX: beta.x + 20, clientY: beta.y + 20 });
    fireEvent.pointerDown(connector, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(map, { pointerId: 1, clientX: 5, clientY: 5000 });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(relations.onCreate).not.toHaveBeenCalled();
  });

  it("selects a relation to delete it (also with Delete), with undo for a while", async () => {
    const { map, relations } = setup();
    const pill = within(map).getByRole("button", { name: "Relation alpha – beta: same budget" });
    await userEvent.click(pill);
    await userEvent.click(within(map).getByRole("button", { name: "Delete the relation alpha – beta" }));
    await waitFor(() => expect(relations.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" })));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(relations.onUndoDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
    pill.focus();
    await userEvent.keyboard("{Delete}");
    await waitFor(() => expect(relations.onDelete).toHaveBeenCalledTimes(2));
  });

  it("a selected relation's note can be changed (改說明)", async () => {
    const { map, relations } = setup();
    await userEvent.click(within(map).getByRole("button", { name: "Relation alpha – beta: same budget" }));
    await userEvent.click(within(map).getByRole("button", { name: "Edit the note" }));
    const note = within(map).getByRole("textbox", { name: "What connects them" });
    expect(note).toHaveValue("same budget");
    await userEvent.clear(note);
    await userEvent.type(note, "same disks{Enter}");
    await waitFor(() => expect(relations.onUpdateLabel).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }), "same disks"));
  });

  it("an AI relation is dashed, with confirm and remove", async () => {
    const suggestion = normalizeSuggestion({ id: "s1", feature: "relations", kind: "relation", status: "open", payload: { fromLineId: "beta", toLineId: "gamma", fromTitle: "beta", toTitle: "gamma", label: "AI says" } });
    const { map, relations } = setup({ relations: [], suggestions: [suggestion] });
    const path = map.querySelector("path[data-tg-relation-suggested]")!;
    expect(path.getAttribute("stroke-dasharray")).toBeTruthy();
    const box = within(map).getByRole("group", { name: "AI suggestion · to confirm: beta – gamma" });
    await userEvent.click(within(box).getByRole("button", { name: "Confirm" }));
    expect(relations.onAccept).toHaveBeenCalledWith(suggestion);
    await userEvent.click(within(box).getByRole("button", { name: "Remove" }));
    expect(relations.onDismiss).toHaveBeenCalledWith(suggestion);
  });

  it("a viewer sees the relations but no dots, no delete and no confirm", async () => {
    const suggestion = normalizeSuggestion({ id: "s1", feature: "relations", kind: "relation", status: "open", payload: { fromLineId: "beta", toLineId: "gamma", fromTitle: "beta", toTitle: "gamma" } });
    const { map } = setup({ readOnly: true, suggestions: [suggestion] });
    expect(map.querySelectorAll("[data-tg-connector]")).toHaveLength(0);
    await userEvent.click(within(map).getByRole("button", { name: "Relation alpha – beta: same budget" }));
    expect(within(map).queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(within(map).queryByRole("button", { name: "Confirm" })).toBeNull();
    within(map).getByRole("button", { name: /^alpha/ }).focus();
    await act(async () => {
      await userEvent.keyboard("r");
    });
    expect(screen.getByRole("status", { name: "Relation status" })).toHaveTextContent("");
  });

  it("counter-scales relation pills and AI suggestion cards when zoomed out", async () => {
    const suggestion = normalizeSuggestion({ id: "s1", feature: "relations", kind: "relation", status: "open", payload: { fromLineId: "beta", toLineId: "gamma", fromTitle: "beta", toTitle: "gamma", label: "AI says" } });
    const { map } = setup({ suggestions: [suggestion] });
    map.focus();
    // Press '-' 5 times to reach 50% zoom (MAP_ZOOM_MIN = 0.5).
    await userEvent.keyboard("-----");
    expect(screen.getByRole("status", { name: /50/ })).toBeInTheDocument();
    const box = within(map).getByRole("group", { name: "AI suggestion · to confirm: beta – gamma" });
    expect(box.style.transform).toContain("scale(2)");
    const pill = within(map).getByRole("button", { name: "Relation alpha – beta: same budget" }).parentElement!;
    expect(pill.style.transform).toContain("scale(2)");
  });
});
