import { normalizeBranchView, normalizeMessage, type BranchView, type Message } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario, type MockTangentClient } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BranchResultBar } from "../branch/branch-result-bar";
import { loadMarkdownRenderer } from "../markdown";
import { OutlineTree } from "../structure/outline-tree";
import { mockClient, tangentWrapper, testQueryClient } from "../test-utils";
import AsideInlineCard from "./aside-inline-card";
import { MessageList } from "./message-list";

/** F18: what becomes of an answered aside (保留 / 接著問 / 丟掉), 刪除支線 in the outline, and what still points at a deleted branch. */

beforeAll(() => loadMarkdownRenderer());
const clients: MockTangentClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

function tracked(options: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient(options);
  clients.push(client);
  return client;
}

async function answeredAside(client: MockTangentClient, purpose = "RAID-Z?"): Promise<BranchView> {
  const created = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "aside" });
  await client.sendMessage(created.line.id, { content: `What is ${purpose}` });
  await waitFor(async () => expect((await client.getBranch(created.line.id)).branch.status).toBe("discarded"));
  return (await client.getBranch(created.line.id)).branch;
}

/** The scenario with one feature off. */
function withoutFeature(name: string) {
  const scenario = nasScenario();
  return { ...scenario, capabilities: { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === name ? { ...feature, enabled: false } : feature)) } };
}

describe("an answered aside opened in place (F18 §2.1)", () => {
  it("is kept and let go again from its footer; the server's copy follows", async () => {
    const client = tracked();
    const aside = await answeredAside(client);
    const { rerender } = render(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    const keep = await within(region).findByRole("button", { name: "Keep" });
    expect(region.querySelector("[data-tg-aside-fate]")).toHaveTextContent(/Clears in \d+ days/);
    await userEvent.click(keep);
    await waitFor(async () => expect((await client.getBranch(aside.lineId)).branch.keptAt).toEqual(expect.any(String)));
    // The outline's copy (the card's `branch`) now says kept.
    rerender(<AsideInlineCard branch={(await client.getBranch(aside.lineId)).branch} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} />);
    expect(region.querySelector("[data-tg-aside-fate]")).toHaveTextContent("Kept");
    const unkeep = within(region).getByRole("button", { name: "Stop keeping" });
    expect(unkeep).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(unkeep);
    await waitFor(async () => expect("keptAt" in (await client.getBranch(aside.lineId)).branch).toBe(false));
  });

  it("hands 接著問 and 丟掉 to its host, and saving the answer keeps the aside too", async () => {
    const client = tracked();
    const aside = await answeredAside(client);
    const onAction = vi.fn();
    render(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} onAction={onAction} />, { wrapper: tangentWrapper(client) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    await userEvent.click(await within(region).findByRole("button", { name: "Keep asking" }));
    await userEvent.click(within(region).getByRole("button", { name: "Throw away" }));
    expect(onAction.mock.calls.map(([branch, action]) => [branch.lineId, action])).toEqual([
      [aside.lineId, "continue"],
      [aside.lineId, "discard"],
    ]);
    // F19 (追加 B.2): taking the answer along is in the card's 「⋯」 now.
    await userEvent.click(within(region).getByRole("button", { name: "More for this aside" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Save to notes" }));
    await waitFor(async () => expect((await client.getBranch(aside.lineId)).branch.keptAt).toEqual(expect.any(String)));
    await userEvent.click(within(region).getByRole("button", { name: "More for this aside" }));
    expect(await screen.findByRole("menuitem", { name: "Saved to notes" })).toHaveAttribute("aria-disabled", "true");
  });

  it("F19: offers 存進名詞表 only while the host can save a term, hands it over, and reads 已存進名詞表 once the aside has a term", async () => {
    // Arrange
    const client = tracked();
    const aside = await answeredAside(client);
    const onAction = vi.fn();
    const { rerender } = render(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} onAction={onAction} />, { wrapper: tangentWrapper(client) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    await within(region).findByRole("button", { name: "Keep asking" });
    const listTerms = vi.spyOn(client, "listTerms");

    // Assert: without the glossary there is no button and nothing is asked.
    expect(within(region).queryByRole("button", { name: "Save to glossary" })).toBeNull();
    expect(listTerms).not.toHaveBeenCalled();

    // Act
    rerender(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} onAction={onAction} canSaveTerm />);
    await userEvent.click(await within(region).findByRole("button", { name: "Save to glossary" }));

    // Assert
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ lineId: aside.lineId }), "term");

    // Act: the save itself is the host's dialog; once the tree has a term from this aside the card says so.
    await client.createTerm(aside.lineId, { term: "RAID-Z", explanation: "ZFS's parity layout." });
    rerender(<AsideInlineCard key="again" branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} onAction={onAction} canSaveTerm />);

    // Assert
    const again = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    expect(await within(again).findByRole("button", { name: "In the glossary" })).toHaveAttribute("aria-pressed", "true");
  });

  it("追加 B.2: the footer keeps what happens to the aside in view and puts the rest in 「⋯」", async () => {
    // Arrange
    const client = tracked();
    const aside = await answeredAside(client);
    const onExpandFull = vi.fn();
    const onCollapse = vi.fn();
    render(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={onExpandFull} onCollapse={onCollapse} onAction={vi.fn()} canSaveTerm />, { wrapper: tangentWrapper(client) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    await within(region).findByRole("button", { name: "Keep asking" });

    // Assert: four actions and the menu in the footer.
    const footer = region.querySelector("footer")!;
    expect(within(footer).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Keep", "Keep asking", "Save to glossary", "Throw away", "More for this aside"]);

    // Act
    await userEvent.click(within(footer).getByRole("button", { name: "More for this aside" }));

    // Assert
    // The card remembers per page what it already kept of an aside (ids repeat across this file's mocks), hence "Save(d)".
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([expect.stringMatching(/^Saved? to notes$/), expect.stringMatching(/^Saved? as memo$/), "Open full view", "Collapse"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Open full view" }));
    expect(onExpandFull).toHaveBeenCalledWith(expect.objectContaining({ lineId: aside.lineId }));
  });

  it("offers neither 保留 nor 接著問 while asides are off (the server would refuse); 丟掉 stays", async () => {
    const on = tracked();
    const aside = await answeredAside(on);
    const off = tracked({ scenario: { ...withoutFeature("aside"), branches: [...on.mock.snapshot().branches], lines: [...on.mock.snapshot().lines], messages: [...on.mock.snapshot().messages] } });
    render(<AsideInlineCard branch={aside} readOnly={false} onExpandFull={vi.fn()} onCollapse={vi.fn()} onAction={vi.fn()} />, { wrapper: tangentWrapper(off) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    await within(region).findByRole("button", { name: "Throw away" });
    expect(within(region).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "Keep asking" })).toBeNull();
  });

  it("shows none of these writes to a read-only identity", async () => {
    const client = tracked();
    const aside = await answeredAside(client);
    render(<AsideInlineCard branch={aside} readOnly onExpandFull={vi.fn()} onCollapse={vi.fn()} onAction={vi.fn()} />, { wrapper: tangentWrapper(client) });
    const region = await screen.findByRole("region", { name: "Aside: RAID-Z?" });
    await within(region).findByRole("button", { name: "Collapse" });
    for (const name of ["Keep", "Keep asking", "Throw away", "Save to notes", "Save to glossary", "More for this aside"]) expect(within(region).queryByRole("button", { name })).toBeNull();
  });
});

describe("刪除支線 in the outline (F18 §2.3)", () => {
  const view = (lineId: string, extra: Record<string, unknown> = {}): BranchView => normalizeBranchView({ lineId, parentLineId: "root", rootLineId: "root", purpose: lineId, status: "open", createdAt: "2026-01-01T00:00:00Z", ...extra });
  const BRANCHES = [
    view("open-one"),
    view("dropped", { status: "discarded" }),
    view("answered", { kind: "aside", status: "discarded", keptAt: "2026-11-13T00:00:00Z" }),
    view("brought-back", { status: "merged" }),
    view("combined", { status: "discarded", mergedIntoLineId: "gone-target" }),
  ];
  const rowOf = (name: string) => screen.getByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
  /** The rows that offer 刪除支線, by their first word. */
  const deletableRows = () =>
    screen
      .getAllByRole("treeitem")
      .filter((row) => row.querySelector("[data-tg-delete]"))
      .map((row) => row.getAttribute("aria-label")?.split(",")[0]);

  it("offers it only on branches that can go: an ended aside and a discarded branch", () => {
    const { unmount } = render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(BRANCHES.length + 1);
    expect(deletableRows().sort()).toEqual(["answered", "dropped"]);
    expect(rowOf("dropped")).toHaveAttribute("aria-keyshortcuts", "Delete");
    expect(rowOf("open-one")).not.toHaveAttribute("aria-keyshortcuts");
    unmount();
    // The previous main line (a promotion's old tail) is discarded too, and stays.
    render(<OutlineTree branches={[view("old-main", { status: "discarded", origin: "previous_main_line" }), view("dropped-too", { status: "discarded" })]} rootLineId="root" currentLineId="root" onEnter={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    expect(deletableRows()).toEqual(["dropped-too"]);
  });

  it("asks the host with the row's button or Delete on the row, and never enters the branch", async () => {
    const onDelete = vi.fn();
    const onEnter = vi.fn();
    render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={onEnter} onDelete={onDelete} />);
    await userEvent.click(rowOf("dropped").querySelector<HTMLElement>("[data-tg-delete]")!);
    expect(onDelete).toHaveBeenLastCalledWith(expect.objectContaining({ lineId: "dropped" }));
    expect(onEnter).not.toHaveBeenCalled();
    rowOf("answered").focus();
    await userEvent.keyboard("{Delete}");
    expect(onDelete).toHaveBeenLastCalledWith(expect.objectContaining({ lineId: "answered" }));
    // Delete on a branch that cannot go does nothing.
    rowOf("open-one").focus();
    await userEvent.keyboard("{Delete}");
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("is not offered to a read-only identity, nor without a host for it", async () => {
    const onDelete = vi.fn();
    const { unmount } = render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} onDelete={onDelete} readOnly />);
    expect(document.querySelector("[data-tg-delete]")).toBeNull();
    rowOf("dropped").focus();
    await userEvent.keyboard("{Delete}");
    expect(onDelete).not.toHaveBeenCalled();
    unmount();
    render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    expect(document.querySelector("[data-tg-delete]")).toBeNull();
  });

  it("says a kept aside is kept, and that the branch a row was combined into is gone (no name, nothing to follow)", () => {
    render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" onEnter={vi.fn()} />);
    expect(rowOf("answered")).toHaveAccessibleName(expect.stringContaining("kept"));
    expect(rowOf("answered").querySelector("[data-tg-kept]")).not.toBeNull();
    const combined = rowOf("combined");
    expect(combined).toHaveAccessibleName(expect.stringContaining("Combined into a branch that is gone"));
    expect(combined.querySelector('[data-tg-merged-into="gone"]')).toHaveTextContent("Combined into a branch that is gone");
    expect(within(combined).queryByRole("button", { hidden: false })).toBeNull();
  });
});

describe("what still points at a deleted branch (F18 §2.3, addendum B)", () => {
  const message = (id: string, seq: number, over: Record<string, unknown>): Message => normalizeMessage({ id, seq, lineId: NAS_ROOT_ID, status: "done", createdAt: "2026-01-01T00:00:00Z", ...over });

  it("a marker whose branch was deleted reads 已刪除 and offers no way in; one whose branch is in the outline still links", async () => {
    const client = tracked();
    // A conversation of two rounds; the second is moved to a branch, which is then not brought back and deleted.
    const line = await client.createLine({ title: "Trip" });
    for (const content of ["When should I go?", "And where should I stay?"]) {
      await client.sendMessage(line.id, { content });
      await waitFor(async () => expect((await client.getLine(line.id)).status).toBe("idle"));
    }
    const moved = await client.moveToBranch(line.id, { count: 2, purpose: "Pick the hotel" });
    const other = await client.createBranch(line.id, { anchorMessageId: (await client.listMessages(line.id)).messages[0]!.id, purpose: "Pick the week", kind: "investigate" });
    await client.discardBranch(moved.branch.lineId);
    await client.deleteBranch(moved.branch.lineId);
    // The marker stays on the line (B23); a second marker points at a branch that is still there.
    const there = message("marker-there", 9_999_999, { lineId: line.id, role: "system", kind: "branch_marker", content: "Pick the week", meta: { branchLineId: other.line.id } });
    const messages = [...(await client.listMessages(line.id)).messages, there];
    expect(messages.some((item) => item.id === moved.marker.id)).toBe(true);
    const branches = (await client.listBranches(line.id, { includeAside: true })).branches;
    const onOpenBranch = vi.fn();
    render(<MessageList lineId={line.id} messages={messages} branches={branches} branchesLoaded onOpenBranch={onOpenBranch} />, { wrapper: tangentWrapper(client, testQueryClient()) });
    const goneRow = document.querySelector(`[data-message-id="${moved.marker.id}"]`) as HTMLElement;
    const thereRow = document.querySelector('[data-message-id="marker-there"]') as HTMLElement;
    await waitFor(() => expect(goneRow.querySelector("[data-tg-marker-gone]")).toHaveTextContent("(branch deleted)"));
    expect(within(goneRow).queryByRole("button", { name: "Open the branch" })).toBeNull();
    await userEvent.click(within(thereRow).getByRole("button", { name: "Open the branch" }));
    expect(onOpenBranch.mock.calls.map(([lineId]) => lineId)).toEqual([other.line.id]);
  });

  it("a marker whose branch only left this outline (it still exists) keeps its link, and nothing is looked up before the outline is loaded", async () => {
    const client = tracked();
    // nas-b3 exists, but the outline given here does not have it (as when the branch moved to another conversation).
    const moved = { branch: { lineId: "nas-b3" } };
    const getLine = vi.spyOn(client, "getLine");
    const marker = message("marker-moved", 99, { role: "system", kind: "branch_marker", content: "Pick the week", meta: { branchLineId: moved.branch.lineId } });
    const { rerender } = render(<MessageList lineId={NAS_ROOT_ID} messages={[marker]} branches={[]} onOpenBranch={vi.fn()} />, { wrapper: tangentWrapper(client, testQueryClient()) });
    expect(getLine).not.toHaveBeenCalled();
    rerender(<MessageList lineId={NAS_ROOT_ID} messages={[marker]} branches={[]} branchesLoaded onOpenBranch={vi.fn()} />);
    await waitFor(() => expect(getLine).toHaveBeenCalledWith(moved.branch.lineId, expect.anything()));
    await waitFor(async () => expect((await getLine.mock.results[0]!.value).id).toBe(moved.branch.lineId));
    expect(screen.getByRole("button", { name: "Open the branch" })).toBeInTheDocument();
    expect(document.querySelector("[data-tg-marker-gone]")).toBeNull();
  });

  it("the result bar of a branch combined into one that is gone says so, with no link there; a kept aside reads kept", () => {
    const client = tracked();
    const combined = normalizeBranchView({ lineId: "a", parentLineId: "root", rootLineId: "root", status: "discarded", mergedIntoLineId: "gone-target" });
    const onShowMerged = vi.fn();
    const { rerender } = render(<BranchResultBar branch={combined} mergedIntoGone onShowMerged={onShowMerged} />, { wrapper: tangentWrapper(client) });
    expect(screen.getByRole("status")).toHaveTextContent("Combined into a branch that is gone");
    expect(screen.queryByRole("button")).toBeNull();
    // Still loading (not known to be gone): the plain outcome, as before.
    rerender(<BranchResultBar branch={combined} />);
    expect(screen.getByRole("status")).not.toHaveTextContent("Combined into");
    // Its target is known: named and linked, whatever `mergedIntoGone` says.
    rerender(<BranchResultBar branch={combined} mergedIntoTitle="Pick the router" mergedIntoGone onShowMerged={onShowMerged} />);
    expect(screen.getByRole("button", { name: "Go to “Pick the router”" })).toBeInTheDocument();
    const kept = normalizeBranchView({ lineId: "k", parentLineId: "root", rootLineId: "root", kind: "aside", status: "discarded", closedAt: "2026-11-13T00:00:00Z", keptAt: "2026-11-13T00:00:00Z" });
    rerender(<BranchResultBar branch={kept} />);
    expect(screen.getByRole("status")).toHaveTextContent("Answered. Kept.");
    rerender(<BranchResultBar branch={{ ...kept, keptAt: undefined } as BranchView} now={Date.parse("2026-11-13T00:00:00Z")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Answered. Cleared in 7 day(s).");
  });
});
