import { normalizeBranchView, type BranchView, type Chapter } from "@tangent/client";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchMap } from "./branch-map";
import { OutlineTree } from "./outline-tree";

afterEach(cleanup);

let seq = 0;
function view(id: string, parent: string): BranchView {
  seq += 1;
  return normalizeBranchView({ lineId: id, parentLineId: parent, rootLineId: "root", purpose: id, status: "open", createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z` });
}

const chapter = (index: number, over: Partial<Chapter>): Chapter => ({
  index,
  title: "",
  titleSource: "topic",
  kind: "topic",
  milestoneId: "",
  startMessageId: `m${index}`,
  endMessageId: `m${index}`,
  startAt: "2026-10-12T13:40:00Z",
  endAt: "2026-10-12T14:15:00Z",
  messageCount: 2,
  branchIds: [],
  cardMessageIds: [],
  ...over,
});

const BRANCHES = [view("alpha", "root"), view("alpha-one", "alpha"), view("beta", "root"), view("gamma", "root")];
const CHAPTERS = [
  chapter(0, { title: "Needs", kind: "start", messageCount: 15, branchIds: ["alpha"] }),
  // A branch the map does not draw is not counted.
  chapter(1, { title: "Hardware", messageCount: 3, branchIds: ["beta", "gamma", "gone"] }),
  chapter(2, { title: "Backups", messageCount: 2 }),
];

describe("BranchMap: the main line's stages (F11 §3)", () => {
  function setup(props: Partial<Parameters<typeof BranchMap>[0]> = {}) {
    const onEnter = vi.fn();
    const onGoToChapter = vi.fn();
    render(<BranchMap branches={BRANCHES} rootLineId="root" currentLineId="root" mainCount={20} onEnter={onEnter} chapters={CHAPTERS} onGoToChapter={onGoToChapter} {...props} />);
    return { onEnter, onGoToChapter, map: screen.getByRole("group", { name: "Branch map" }) };
  }

  it("draws one stage per chapter under the main node, with its name, messages and branches", () => {
    const { map } = setup();
    expect(map.querySelector('[data-tg-map-node="__main__"]')).not.toBeNull();
    const stages = within(map).getByRole("list", { name: "Main line chapters" });
    expect([...stages.querySelectorAll("[data-tg-map-chapter]")].map((node) => node.getAttribute("data-tg-map-chapter"))).toEqual(["0", "1", "2"]);
    const hardware = within(stages).getByRole("button", { name: "§2 Hardware, 3 messages, 2 branch(es) from it; go to this part of the main line" });
    expect(hardware).toHaveTextContent("§2 Hardware");
    expect(hardware).toHaveTextContent("3 messages");
    expect(hardware).toHaveTextContent("↳ 2 branch(es)");
    expect(within(stages).getByRole("button", { name: /^§1 Needs, 15 messages, 1 branch/ })).toHaveTextContent("↳ 1 branch(es)");
    const backups = within(stages).getByRole("button", { name: "§3 Backups, 2 messages; go to this part of the main line" });
    expect(backups.querySelector("[data-tg-chapter-branches]")).toBeNull();
  });

  it("stacks the stages in the main node's column below it, clear of the branch nodes", () => {
    const { map } = setup();
    const box = (element: Element) => {
      const style = (element as HTMLElement).style;
      return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top), w: Number.parseFloat(style.width), h: Number.parseFloat(style.height) };
    };
    const main = box(map.querySelector('[data-tg-map-node="__main__"]')!);
    const stages = [...map.querySelectorAll("[data-tg-map-chapter]")].map(box);
    const branches = [...map.querySelectorAll("[data-tg-map-node]:not([data-tg-map-node='__main__'])")].map(box);
    expect(branches.length).toBe(4);
    let floor = main.y + main.h;
    for (const stage of stages) {
      expect(stage.x).toBe(main.x);
      expect(stage.y).toBeGreaterThan(floor);
      floor = stage.y + stage.h;
      for (const node of branches) expect(stage.x + stage.w <= node.x || node.x + node.w <= stage.x || stage.y + stage.h <= node.y || node.y + node.h <= stage.y).toBe(true);
    }
  });

  it("goes to a chapter's start by click, Enter or Space, without entering a line", async () => {
    const { onGoToChapter, onEnter } = setup();
    const stage = screen.getByRole("button", { name: /^§3 Backups/ });
    await userEvent.click(stage);
    expect(onGoToChapter).toHaveBeenLastCalledWith(CHAPTERS[2]);
    stage.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onGoToChapter).toHaveBeenCalledTimes(3);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("comes right after the main node (and its fold toggle) in the Tab order", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Main line, 20 messages" }));
    await userEvent.tab();
    expect(document.activeElement).toHaveAccessibleName("Fold the branches below Main line");
    await userEvent.tab();
    expect(document.activeElement).toHaveAccessibleName(/^§1 Needs/);
  });

  it("draws no stage without chapters, with one chapter (the main node says it all) or without a way to go", () => {
    for (const props of [{ chapters: undefined }, { chapters: [] }, { chapters: CHAPTERS.slice(0, 1) }, { onGoToChapter: undefined }]) {
      const { map } = setup(props);
      expect(map.querySelector("[data-tg-map-chapter]")).toBeNull();
      expect(map.querySelector('[data-tg-map-node="__main__"]')).not.toBeNull();
      cleanup();
    }
  });
});

describe("OutlineTree: the main line's stages (F11 §3)", () => {
  function setup(chapters: readonly Chapter[] | undefined) {
    const onEnter = vi.fn();
    const onGoToChapter = vi.fn();
    render(<OutlineTree branches={BRANCHES} rootLineId="root" currentLineId="root" mainCount={20} onEnter={onEnter} {...(chapters ? { chapters } : {})} onGoToChapter={onGoToChapter} />);
    return { onEnter, onGoToChapter, tree: screen.getByRole("tree", { name: "Branch outline" }) };
  }

  it("shows a strip of stages from two chapters on, outside the tree, and goes to a chapter's start", async () => {
    const { onGoToChapter, onEnter, tree } = setup(CHAPTERS);
    const strip = screen.getByRole("group", { name: "Main line chapters" });
    expect(tree.contains(strip)).toBe(false);
    expect(within(strip).getAllByRole("button").map((button) => button.textContent)).toEqual(["§1 Needs", "§2 Hardware", "§3 Backups"]);
    await userEvent.click(within(strip).getByRole("button", { name: /^§2 Hardware, 3 messages/ }));
    expect(onGoToChapter).toHaveBeenCalledWith(CHAPTERS[1]);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("leaves the tree's keys alone: the rows are still the only tree items and arrows move between them", async () => {
    const { tree } = setup(CHAPTERS);
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows).toHaveLength(5);
    rows[0]!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
  });

  it("shows no strip with fewer than two chapters", () => {
    setup(CHAPTERS.slice(0, 1));
    expect(screen.queryByRole("group", { name: "Main line chapters" })).toBeNull();
    cleanup();
    setup(undefined);
    expect(screen.queryByRole("group", { name: "Main line chapters" })).toBeNull();
  });
});
