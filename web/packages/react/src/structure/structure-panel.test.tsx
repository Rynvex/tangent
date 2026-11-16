import { normalizeBranchView } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { ExportBar } from "./export-bar";
import { ShortcutsProvider, useShortcutsActions } from "../shortcuts";
import { MAP_HINT_SEEN_KEY } from "./relation-layer";
import { StructurePanel, type StructureView } from "./structure-panel";

afterEach(cleanup);

function setup(options: { features?: "all" | "core"; allowMap?: boolean; view?: StructureView } = {}) {
  const client = mockClient({ scenario: nasScenario({ features: options.features ?? "all" }) });
  const onViewChange = vi.fn();
  const onEnter = vi.fn();
  render(
    <StructurePanel
      rootLineId={NAS_ROOT_ID}
      currentLineId={NAS_ROOT_ID}
      title="家用 NAS"
      view={options.view ?? "outline"}
      onViewChange={onViewChange}
      allowMap={options.allowMap ?? true}
      onEnter={onEnter}
      onJump={() => undefined}
    />,
    { wrapper: tangentWrapper(client) },
  );
  return { client, onViewChange, onEnter };
}

describe("StructurePanel: the main line's stages (F11 §3)", () => {
  function stagesSetup(features: "all" | "core", view: StructureView) {
    const client = mockClient({ scenario: nasScenario({ features }) });
    const onOpen = vi.fn();
    render(
      <StructurePanel rootLineId={NAS_ROOT_ID} currentLineId="nas-b1" title="家用 NAS" view={view} onViewChange={() => undefined} allowMap onEnter={() => undefined} onJump={() => undefined} onOpen={onOpen} />,
      { wrapper: tangentWrapper(client) },
    );
    return { client, onOpen };
  }

  it("puts the main line's chapters under its map node and goes to a chapter's first message", async () => {
    const { client, onOpen } = stagesSetup("all", "map");
    const stages = await screen.findByRole("list", { name: "Main line chapters" });
    await waitFor(() => expect(stages.querySelectorAll("[data-tg-map-chapter]")).toHaveLength(4));
    await userEvent.click(within(stages).getByRole("button", { name: /^§2 硬體選擇, 3 messages, 2 branch/ }));
    expect(onOpen).toHaveBeenCalledWith(NAS_ROOT_ID, "nas-m16");
    client.mock.dispose();
  });

  it("shows the stage strip above the outline", async () => {
    const { client, onOpen } = stagesSetup("all", "outline");
    const strip = await screen.findByRole("group", { name: "Main line chapters" });
    await userEvent.click(within(strip).getByRole("button", { name: /^§4 備份策略/ }));
    expect(onOpen).toHaveBeenCalledWith(NAS_ROOT_ID, "nas-m39");
    client.mock.dispose();
  });

  it("shows no stages while the chapters feature is off", async () => {
    const { client } = stagesSetup("core", "map");
    expect(await screen.findByRole("group", { name: "Branch map" })).toBeInTheDocument();
    await screen.findAllByRole("button", { name: /^Main line, / });
    expect(document.querySelector("[data-tg-map-chapter]")).toBeNull();
    client.mock.dispose();
  });
});

describe("StructurePanel (A8, A10)", () => {
  it("switches between outline, map and chapters", async () => {
    const { client, onViewChange } = setup();
    const views = await screen.findByRole("radiogroup", { name: "View" });
    await waitFor(() => expect(within(views).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Outline", "Map", "Chapters"]));
    expect(within(views).getByRole("radio", { name: "Outline" })).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByRole("tree", { name: "Branch outline" })).toBeInTheDocument();
    await userEvent.click(within(views).getByRole("radio", { name: "Map" }));
    expect(onViewChange).toHaveBeenCalledWith("map");
    client.mock.dispose();
  });

  it("offers no map on narrow frames and no chapters when that feature is off", async () => {
    const { client } = setup({ features: "core", allowMap: false });
    const views = await screen.findByRole("radiogroup", { name: "View" });
    expect(within(views).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Outline"]);
    client.mock.dispose();
  });

  it("shows the map and the chapters when chosen", async () => {
    const first = setup({ view: "map" });
    expect(await screen.findByRole("group", { name: "Branch map" })).toBeInTheDocument();
    first.client.mock.dispose();
    cleanup();
    const second = setup({ view: "chapters" });
    expect(await screen.findByRole("list", { name: "Chapters" })).toBeInTheDocument();
    second.client.mock.dispose();
  });
});

describe("ExportBar", () => {
  it("exports the outline as Markdown, a Mermaid mindmap or OPML", async () => {
    const download = vi.fn();
    const branches = [normalizeBranchView({ lineId: "a", parentLineId: "r", rootLineId: "r", purpose: "Rail passes", status: "merged", conclusionLine: "JR pass" })];
    render(<ExportBar title="Kyoto trip" branches={branches} download={download} />, { wrapper: tangentWrapper(mockClient()) });
    const group = screen.getByRole("group", { name: "Export" });
    await userEvent.click(within(group).getByRole("button", { name: "Markdown" }));
    expect(download).toHaveBeenLastCalledWith("Kyoto trip.md", "text/markdown", expect.stringContaining("- Rail passes (Brought back) — Conclusion: JR pass"));
    await userEvent.click(within(group).getByRole("button", { name: "Mermaid" }));
    expect(download).toHaveBeenLastCalledWith("Kyoto trip.mmd", "text/plain", expect.stringContaining('b_a["Rail passes (Brought back) — Conclusion: JR pass"]'));
    await userEvent.click(within(group).getByRole("button", { name: "OPML" }));
    expect(download).toHaveBeenLastCalledWith("Kyoto trip.opml", "text/x-opml", expect.stringContaining('<outline text="Rail passes" _status="Brought back"'));
  });
});

describe("StructurePanel: renaming (B5 PATCH /branch)", () => {
  it("renames an open branch from the outline with F2 through the server", async () => {
    const { client } = setup();
    const tree = await screen.findByRole("tree", { name: "Branch outline" });
    const row = await within(tree).findByRole("treeitem", { name: /^4TB 與 8TB/ });
    row.focus();
    await userEvent.keyboard("{F2}");
    const input = screen.getByRole("textbox", { name: "New purpose" });
    await userEvent.clear(input);
    await userEvent.type(input, "只看 8TB{Enter}");
    await waitFor(async () => expect((await client.getBranch("nas-b3")).branch.purpose).toBe("只看 8TB"));
    await waitFor(() => expect(within(tree).getByRole("treeitem", { name: /^只看 8TB/ })).toBeInTheDocument());
    client.mock.dispose();
  });
});

describe("StructurePanel: relations (C3, F5)", () => {
  it("lists the tree's relations under the outline and opens the relation dialog from 新增關聯", async () => {
    const { client } = setup();
    await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", label: "same budget" });
    const relations = await screen.findByRole("region", { name: /^Relations/ });
    expect(await within(relations).findByText("same budget")).toBeInTheDocument();
    await userEvent.click(within(relations).getByRole("button", { name: "Add a relation" }));
    const dialog = await screen.findByRole("dialog", { name: "Relate" });
    expect(within(dialog).getByText("Main line")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("draws them on the map with the 關聯 layer", async () => {
    const { client } = setup({ view: "map" });
    await client.createRelation(NAS_ROOT_ID, { fromLineId: "nas-b3", toLineId: "nas-b2", label: "same budget" });
    expect(await screen.findByRole("group", { name: "Map layers" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /^Relation .*: same budget$/ })).toBeInTheDocument();
    client.mock.dispose();
  });

  it("has no relations anywhere while the feature is off", async () => {
    const { client } = setup({ features: "core", view: "map" });
    await screen.findByRole("group", { name: "Branch map" });
    expect(screen.queryByRole("group", { name: "Map layers" })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Relations/ })).toBeNull();
    client.mock.dispose();
  });
});

describe("StructurePanel: the 魚眼 layer (C1, F5 phase 2)", () => {
  it("turns on from the map's layers and fades each node by what AI sees", async () => {
    const { client } = setup({ view: "map" });
    const layers = await screen.findByRole("group", { name: "Map layers" });
    const fisheye = await within(layers).findByRole("button", { name: "Fisheye" });
    expect(fisheye).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(fisheye);
    const map = screen.getByRole("group", { name: "Branch map" });
    // The main line (on screen) in full; an ended branch only by its leaf.
    await waitFor(() => expect(map.querySelector('[data-tg-map-node="__main__"]')?.getAttribute("data-fisheye-level")).toBe("full"));
    expect(map.querySelector('[data-tg-map-node="nas-b5"]')?.getAttribute("data-fisheye-level")).toBe("leaf_only");
    expect(screen.getByRole("list", { name: "Opacity = how much AI sees" })).toBeInTheDocument();
    client.mock.dispose();
  });

  it("has no 魚眼 layer while the feature is off", async () => {
    const { client } = setup({ features: "core", view: "map" });
    await screen.findByRole("group", { name: "Branch map" });
    expect(screen.queryByRole("button", { name: "Fisheye" })).toBeNull();
    client.mock.dispose();
  });

});

describe("StructurePanel: nothing to list, nothing shown (F19 §4)", () => {
  it("shows neither 群組 nor 關聯 under the outline while the tree has none, and the palette's 建立關聯… opens the dialog", async () => {
    // Arrange
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    function Run() {
      const { run } = useShortcutsActions();
      return (
        <button type="button" onClick={() => run("relation.add")}>
          run relation.add
        </button>
      );
    }
    const Wrapper = tangentWrapper(client);
    render(
      <ShortcutsProvider platform="other">
        <StructurePanel rootLineId={NAS_ROOT_ID} currentLineId={NAS_ROOT_ID} title="家用 NAS" view="outline" onViewChange={() => undefined} allowMap onEnter={() => undefined} onJump={() => undefined} />
        <Run />
      </ShortcutsProvider>,
      { wrapper: Wrapper },
    );
    const tree = await screen.findByRole("tree", { name: "Branch outline" });
    await waitFor(() => expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(1));

    // Assert: no empty sections, no 新增關聯 button.
    expect(screen.queryByRole("region", { name: /^Relations/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Groups/ })).toBeNull();
    expect(screen.queryByText("No relations yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a relation" })).toBeNull();

    // Act: the way in that is left.
    await userEvent.click(screen.getByRole("button", { name: "run relation.add" }));

    // Assert
    expect(await screen.findByRole("dialog", { name: "Relate" })).toBeInTheDocument();
    client.mock.dispose();
  });

  it("brings the 關聯 section back as soon as the tree has a relation", async () => {
    const { client } = setup();
    await screen.findByRole("tree", { name: "Branch outline" });
    expect(screen.queryByRole("region", { name: /^Relations/ })).toBeNull();
    await client.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", label: "same budget" });
    expect(await screen.findByRole("region", { name: /^Relations/ })).toBeInTheDocument();
    client.mock.dispose();
  });

  it("shows the map's how-to only the first time a map is opened in this browser", async () => {
    // Arrange
    window.localStorage.removeItem(MAP_HINT_SEEN_KEY);
    const first = setup({ view: "map" });
    await screen.findByRole("group", { name: "Branch map" });

    // Assert: the first map shows it and remembers that it did.
    expect(await screen.findByText(/^Drag from a node's right dot/)).toBeInTheDocument();
    expect(window.localStorage.getItem(MAP_HINT_SEEN_KEY)).not.toBeNull();
    first.client.mock.dispose();
    cleanup();

    // Act: another map, later.
    const second = setup({ view: "map" });
    await screen.findByRole("group", { name: "Branch map" });
    await screen.findByRole("group", { name: "Map layers" });

    // Assert
    expect(screen.queryByText(/^Drag from a node's right dot/)).toBeNull();
    second.client.mock.dispose();
  });
});

describe("StructurePanel: groups (C2, F5 phase 3)", () => {
  it("groups (C2): the outline lists them; selecting ended branches and pressing G opens 建立群組, which makes one", async () => {
    const { client } = setup();
    const tree = await screen.findByRole("tree", { name: "Branch outline" });
    // F19 §4: with no group yet the outline shows no 「群組」 section at all (it used to read "No groups yet.").
    await waitFor(() => expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(1));
    expect(screen.queryByText("No groups yet.")).toBeNull();
    expect(screen.queryByRole("region", { name: /^Groups/ })).toBeNull();
    const row = (name: string) => within(tree).getByRole("treeitem", { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(row("用舊筆電當 NAS")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.keyboard("{Shift>}");
    await user.click(row("用舊筆電當 NAS"));
    await user.click(row("二手企業碟可不可靠"));
    await user.keyboard("{/Shift}");
    expect(await screen.findByRole("button", { name: "Create group" })).toBeInTheDocument();
    row("二手企業碟可不可靠").focus();
    await userEvent.keyboard("g");
    const dialog = await screen.findByRole("dialog", { name: "Create a group" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Group name" }), "Hardware");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("article", { name: "Group: Hardware" })).toBeInTheDocument();
    expect(tree).not.toHaveAttribute("aria-multiselectable");
    client.mock.dispose();
  });

  it("without the group feature: no group list, and no multi-select at all (R9 G2)", async () => {
    const { client } = setup({ features: "core" });
    const tree = await screen.findByRole("tree", { name: "Branch outline" });
    await waitFor(() => expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: "Select several" })).toBeNull();
    within(tree).getAllByRole("treeitem")[1]!.focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(tree).not.toHaveAttribute("aria-multiselectable");
    expect(screen.queryByRole("button", { name: /Create group|Combine/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Groups/ })).toBeNull();
    client.mock.dispose();
  });

  it("R9 G1: switching conversations drops the selection and an open group form", async () => {
    const client = mockClient({ scenario: nasScenario({ features: "all" }) });
    const props = { currentLineId: NAS_ROOT_ID, title: "家用 NAS", view: "outline" as const, onViewChange: vi.fn(), allowMap: true, onEnter: vi.fn(), onJump: () => undefined };
    const { rerender } = render(<StructurePanel rootLineId={NAS_ROOT_ID} {...props} />, { wrapper: tangentWrapper(client) });
    const tree = await screen.findByRole("tree", { name: "Branch outline" });
    const row = (name: string) => within(tree).getByRole("treeitem", { name: new RegExp(`^${name}`) });
    await waitFor(() => expect(row("用舊筆電當 NAS")).toBeInTheDocument());
    const user = userEvent.setup();
    await user.keyboard("{Shift>}");
    await user.click(row("用舊筆電當 NAS"));
    await user.click(row("二手企業碟可不可靠"));
    await user.keyboard("{/Shift}");
    await user.click(await screen.findByRole("button", { name: "Create group" }));
    expect(await screen.findByRole("dialog", { name: "Create a group" })).toBeInTheDocument();
    rerender(<StructurePanel rootLineId="osaka" {...props} currentLineId="osaka" />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create a group" })).toBeNull());
    expect(screen.getByRole("tree", { name: "Branch outline" })).not.toHaveAttribute("aria-multiselectable");
    client.mock.dispose();
  });

  it("R9 G2: a viewer gets no multi-select either", async () => {
    const scenario = nasScenario({ features: "all" });
    scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
    const client = mockClient({ scenario });
    render(<StructurePanel rootLineId={NAS_ROOT_ID} currentLineId={NAS_ROOT_ID} title="家用 NAS" view="outline" onViewChange={vi.fn()} allowMap onEnter={vi.fn()} onJump={() => undefined} />, { wrapper: tangentWrapper(client) });
    const tree = await screen.findByRole("tree", { name: "Branch outline" });
    await waitFor(() => expect(within(tree).getAllByRole("treeitem").length).toBeGreaterThan(1));
    expect(screen.queryByRole("button", { name: "Select several" })).toBeNull();
    within(tree).getAllByRole("treeitem")[1]!.focus();
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(tree).not.toHaveAttribute("aria-multiselectable");
    client.mock.dispose();
  });
});

