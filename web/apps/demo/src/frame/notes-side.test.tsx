// @vitest-environment jsdom
import type { CapabilityFeature, Memo } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider, undoTermDeletes } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BranchFlow } from "./branch-flows";
import { otherLineMemos } from "./line-memos";
import { NotesSide, type NotesView } from "./notes-side";

afterEach(cleanup);

/** Every feature on but memory (its footer is a lazy part of its own), with these changes. */
function scenario(off: readonly string[] = []) {
  const base = nasScenario();
  const features: CapabilityFeature[] = base.capabilities.features.map((feature) => (feature.name === "memory" || off.includes(feature.name) ? { name: feature.name, enabled: false } : feature));
  return { ...base, capabilities: { ...base.capabilities, features } };
}

function Host({ lineId, onFlow, navigate, initial }: { lineId: string; onFlow: (flow: BranchFlow) => void; navigate: (lineId: string) => void; initial: NotesView }) {
  const [view, setView] = useState<NotesView>(initial);
  return (
    <>
      <NotesSide rootLineId={NAS_ROOT_ID} lineId={lineId} navigate={navigate} onOpenLibrary={vi.fn()} view={view} onViewChange={setView} onFlow={onFlow} />
      <input aria-label="elsewhere" />
    </>
  );
}

function setup({ lineId = NAS_ROOT_ID, off = [], initial = "notes" }: { lineId?: string; off?: readonly string[]; initial?: NotesView } = {}) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: scenario(off) });
  const onFlow = vi.fn<(flow: BranchFlow) => void>();
  const navigate = vi.fn<(lineId: string) => void>();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other" target="window">
          <Host lineId={lineId} onFlow={onFlow} navigate={navigate} initial={initial} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { client, onFlow, navigate };
}

// F19: with the glossary on (the mock's full set) the switch has three parts and says so.
const kinds = () => screen.findByRole("radiogroup", { name: "Notes, glossary or memos" });
const memosRegion = () => screen.findByRole("region", { name: /^Memos \(not sent to AI\)/ });

describe("NotesSide: 紀要｜備忘 (F10)", () => {
  it("counts the tree's notes and the line's memos, and switches between them", async () => {
    setup({ lineId: "nas-b1" });
    const group = await kinds();
    await waitFor(() => expect(within(group).getByRole("radio", { name: "Memos (my own understanding) 1" })).toBeInTheDocument());
    expect(within(group).getByRole("radio", { name: /^Notes \(for the AI\) \d+$/ })).toHaveAttribute("aria-checked", "true");
    // F19: 紀要｜名詞表｜備忘, in that order.
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([expect.stringMatching(/^Notes/), "Glossary 0", expect.stringMatching(/^Memos/)]);
    expect(screen.queryByRole("region", { name: /^Memos \(not sent to AI\)/ })).toBeNull();
    await userEvent.click(within(group).getByRole("radio", { name: /^Memos/ }));
    expect(await memosRegion()).toHaveTextContent("問一下小陳他家的 ZFS");
  });

  it("opens on 備忘 when the shell asks (after 記成備忘) and lists the other lines' memos with the way there", async () => {
    const { navigate } = setup({ initial: "memos" });
    expect(await memosRegion()).toHaveTextContent("No memos yet.");
    const others = await screen.findByRole("region", { name: "Memos on other lines" });
    await userEvent.click(within(others).getByRole("button", { name: /ZFS mirror 與 Btrfs RAID1/ }));
    expect(navigate).toHaveBeenCalledWith("nas-b1");
  });

  it("shows the memos alone while notes are off, and only the notes while memos are off", async () => {
    // F19: the glossary is a part of its own now, so "alone" also means it is off.
    setup({ off: ["notes", "glossary"], lineId: "nas-b1" });
    expect(await memosRegion()).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    cleanup();
    setup({ off: ["memo", "glossary"] });
    expect(await screen.findByText("檔案系統用 ZFS mirror")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("keeps the two-part switch and its name while the glossary is off, and asks for no terms (F19)", async () => {
    const { client } = setup({ off: ["glossary"], lineId: "nas-b1" });
    const listTerms = vi.spyOn(client, "listTerms");
    const group = await screen.findByRole("radiogroup", { name: "Notes or memos" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(within(group).queryByRole("radio", { name: /Glossary/ })).toBeNull();
    expect(listTerms).not.toHaveBeenCalled();
  });

  it("shows 備忘 first while notes are off (the tab reads 備忘), with 名詞表 next to it (F19)", async () => {
    setup({ off: ["notes"], lineId: "nas-b1" });
    expect(await memosRegion()).toBeInTheDocument();
    const group = await kinds();
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Glossary 0", expect.stringMatching(/^Memos/)]);
  });

  it("名詞表 counts the tree's terms, lists them when chosen, and a deleted one leaves the count at once (F19 §2.2)", async () => {
    const { client } = setup();
    await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "A copy-on-write filesystem." });
    await client.createTerm(NAS_ROOT_ID, { term: "ECC", explanation: "Error-correcting memory." });
    const group = await kinds();
    const radio = await within(group).findByRole("radio", { name: "Glossary 2" });
    await userEvent.click(radio);
    const glossary = await screen.findByRole("region", { name: "Glossary" });
    expect(within(glossary).getAllByRole("listitem").map((item) => item.textContent)).toEqual([expect.stringContaining("ECC"), expect.stringContaining("ZFS")]);
    await userEvent.click(within(glossary).getByRole("button", { name: /^ECC/ }));
    await userEvent.click(within(glossary).getByRole("button", { name: "Delete “ECC”" }));
    expect(await within(group).findByRole("radio", { name: "Glossary 1" })).toBeInTheDocument();
    // The delete itself waits for its undo; take it back so nothing is left waiting after the test.
    expect(undoTermDeletes().map((term) => term.term)).toEqual(["ECC"]);
    expect(await within(group).findByRole("radio", { name: "Glossary 2" })).toBeInTheDocument();
  });

  it("請 AI 檢驗理解… opens the same Feynman branch as focus mode: from where an ended branch forked, the check prefilled", async () => {
    const { onFlow } = setup({ lineId: "nas-b1", initial: "memos" });
    const region = await memosRegion();
    await userEvent.click(await within(region).findByRole("button", { name: "Actions for this memo" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Ask AI to check my understanding…" }));
    expect(onFlow).toHaveBeenCalledWith({
      kind: "open",
      lineId: NAS_ROOT_ID,
      request: expect.objectContaining({ anchorMessageId: "nas-m19", excerpt: "", purpose: expect.stringMatching(/^Check my understanding: 問一下小陳/), notice: expect.stringContaining("has ended") }),
      prefill: { text: expect.stringContaining("問一下小陳他家的 ZFS"), notice: expect.stringMatching(/^Added to the composer, not sent/) },
    });
  });

  it("N opens the new-memo box while the panel has focus (switching to 備忘), never while typing", async () => {
    setup({ lineId: "nas-b1" });
    const group = await kinds();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "elsewhere" }), { key: "n" });
    const notesRadio = within(group).getByRole("radio", { name: /^Notes/ });
    fireEvent.keyDown(notesRadio, { key: "n", ctrlKey: true });
    expect(notesRadio).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(notesRadio, { key: "n" });
    const box = await screen.findByRole("textbox", { name: "Memo" });
    expect(within(group).getByRole("radio", { name: /^Memos/ })).toHaveAttribute("aria-checked", "true");
    // Typing an n in the box writes it, nothing else.
    await userEvent.type(box, "n");
    expect(box).toHaveValue("n");
    expect(screen.getAllByRole("textbox", { name: "Memo" })).toHaveLength(1);
  });
});

describe("otherLineMemos", () => {
  const memo = (id: string, lineId: string, createdAt: string): Memo => ({ id, rootLineId: "r", lineId, sourceLabel: "", text: id, createdBy: "", createdAt, updatedAt: createdAt });

  it("groups the other lines' memos, newest line first, leaving out this line and gone ones", () => {
    const list = otherLineMemos([memo("a", "l1", "2026-01-01"), memo("b", "l2", "2026-01-03"), memo("c", "l1", "2026-01-02"), memo("d", "here", "2026-01-09"), memo("e", "", "2026-01-09")], "here");
    expect(list.map((item) => [item.lineId, item.count, item.latest.id])).toEqual([
      ["l2", 1, "b"],
      ["l1", 2, "c"],
    ]);
  });
});
