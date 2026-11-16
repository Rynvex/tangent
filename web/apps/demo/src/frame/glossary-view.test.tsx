// @vitest-environment jsdom
import type { CapabilityFeature, TermSearchHit } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "@tangent/client/testing";
import { loadMarkdownRenderer, ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BranchFlow } from "./branch-flows";
import { ConversationView } from "./conversation-view";
import GlossaryFlow from "./glossary-flow";

/**
 * F19 in the conversation: the glossary's ways in (a message's menu, the
 * selection toolbar, an answered aside), its underlines, and — with the
 * feature off — none of them and not one request.
 */

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  await loadMarkdownRenderer();
});

const mocks: MockTangentClient[] = [];
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function scenario(off: readonly string[] = []) {
  const base = nasScenario();
  const features: CapabilityFeature[] = base.capabilities.features.map((feature) => (off.includes(feature.name) ? { name: feature.name, enabled: false } : feature));
  return { ...base, capabilities: { ...base.capabilities, features } };
}

function mock(off: readonly string[] = []) {
  const client = createMockTangentClient({ latencyMs: 0, chunkMs: 1, scenario: scenario(off) });
  mocks.push(client);
  return client;
}

function show(client: MockTangentClient, lineId = NAS_ROOT_ID) {
  const onFlow = vi.fn<(flow: BranchFlow) => void>();
  const onShowTerm = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other" target="window">
          <ConversationView lineId={lineId} draft="" onDraftChange={() => {}} forcedBanner={null} focus={null} onFlow={onFlow} navigate={() => {}} onPreview={() => {}} toast={() => {}} onShowTerm={onShowTerm} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { onFlow, onShowTerm };
}

/** The first finished reply of the main line that mentions ZFS, once it is on screen. */
async function zfsReply() {
  const rows = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[data-message-id][data-forkable="true"]')].filter((row) => row.querySelector('article[aria-label^="AI"]') && row.textContent?.includes("ZFS"));
    expect(found.length).toBeGreaterThan(0);
    return found;
  }, { timeout: 4000 });
  return rows[0]!;
}

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    fireEvent(document, new Event("selectionchange"));
  });
}

/** The first text node under `root` that holds `word`. */
function textNodeWith(root: HTMLElement, word: string): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent?.indexOf(word) ?? -1;
    if (at >= 0 && (node.parentElement?.closest("[data-tg-markdown]") ?? null) !== null) return { node: node as Text, at };
  }
  throw new Error(`no text node holds ${word}`);
}

describe("the glossary's ways in", () => {
  it("存進名詞表 in a reply's menu and on the selection toolbar hand the frame a save, with the message and the words", async () => {
    // Arrange
    const client = mock();
    const { onFlow } = show(client);
    const row = await zfsReply();
    const messageId = row.getAttribute("data-message-id")!;

    // Act: the reply's 「⋯」.
    fireEvent.pointerEnter(row.querySelector("[data-tg-message]")!);
    const more = (await within(row).findAllByRole("button", { name: "More actions" })).find((button) => button.getAttribute("aria-haspopup") === "menu")!;
    await userEvent.click(more);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Save to glossary" }));

    // Assert
    expect(onFlow).toHaveBeenLastCalledWith({ kind: "saveTerm", lineId: NAS_ROOT_ID, messageId });

    // Act: the selection toolbar.
    const { node, at } = textNodeWith(row, "ZFS");
    selectText(node, at, at + 3);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    await userEvent.click(within(toolbar).getByRole("button", { name: "Save to glossary" }));

    // Assert
    expect(onFlow).toHaveBeenLastCalledWith({ kind: "saveTerm", lineId: NAS_ROOT_ID, messageId, selection: "ZFS" });
  });

  it("underlines a saved term in the replies and a press shows it in the glossary", async () => {
    // Arrange
    const client = mock();
    const saved = await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "A copy-on-write filesystem." });
    const { onShowTerm } = show(client);

    // Act
    const mark = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-tg-term-mark]");
      expect(found).not.toBeNull();
      return found!;
    }, { timeout: 4000 });

    // Assert: one underline per reply at most, on the term itself.
    expect(mark).toHaveTextContent(/^zfs$/i);
    const perReply = new Map<string, number>();
    for (const item of document.querySelectorAll("[data-tg-term-mark]")) {
      const id = item.closest("[data-message-id]")!.getAttribute("data-message-id")!;
      perReply.set(id, (perReply.get(id) ?? 0) + 1);
    }
    expect([...perReply.values()].every((count) => count === 1)).toBe(true);
    await userEvent.click(mark);
    expect(onShowTerm).toHaveBeenCalledWith(saved.term.id);
  });

  it("「之前問過」 appears for words another conversation's glossary explains, and opens what was said then", async () => {
    // Arrange
    const client = mock();
    const other = await client.createLine({ title: "儲存筆記" });
    await client.createTerm(other.id, { term: "ZFS", explanation: "The explanation from before." });
    const { onFlow } = show(client);
    const row = await zfsReply();
    const { node, at } = textNodeWith(row, "ZFS");

    // Act
    selectText(node, at, at + 3);

    // Assert
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    const chip = await within(toolbar).findByRole("button", { name: "Asked before: 儲存筆記" }, { timeout: 4000 });
    // 秒問解釋 is there all along: the lookup never stands in its way.
    expect(within(toolbar).getByRole("button", { name: "Quick ask" })).toBeInTheDocument();
    await userEvent.click(chip);
    expect(onFlow).toHaveBeenLastCalledWith({ kind: "askedBefore", lineId: NAS_ROOT_ID, messageId: row.getAttribute("data-message-id"), hit: expect.objectContaining({ term: "ZFS", rootTitle: "儲存筆記" }) });
    expect(screen.queryByRole("toolbar", { name: "Selected text" })).toBeNull();
  });
});

describe("with the glossary off", () => {
  it("there is no way in, no underline, and not one glossary request", async () => {
    // Arrange: a term that would be underlined and one that would be "asked before", were the feature on.
    const on = mock();
    const other = await on.createLine({ title: "儲存筆記" });
    await on.createTerm(other.id, { term: "ZFS", explanation: "x" });
    const off = mock(["glossary"]);
    const calls = [vi.spyOn(off, "listTerms"), vi.spyOn(off, "searchTerms"), vi.spyOn(off, "createTerm")];
    const { onFlow } = show(off);
    const row = await zfsReply();

    // Act: everything that offers 存進名詞表 when it is on.
    fireEvent.pointerEnter(row.querySelector("[data-tg-message]")!);
    const more = (await within(row).findAllByRole("button", { name: "More actions" })).find((button) => button.getAttribute("aria-haspopup") === "menu")!;
    await userEvent.click(more);
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    await userEvent.keyboard("{Escape}");
    const { node, at } = textNodeWith(row, "ZFS");
    selectText(node, at, at + 3);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 450)));

    // Assert
    // The menu is there with its other items; only the glossary's is missing.
    expect(items.length).toBeGreaterThan(2);
    expect(items).not.toContain("Save to glossary");
    expect(within(toolbar).queryByRole("button", { name: "Save to glossary" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: /^Asked before/ })).toBeNull();
    expect(document.querySelector("[data-tg-term-mark]")).toBeNull();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(onFlow).not.toHaveBeenCalled();
  });
});

describe("an archived conversation", () => {
  it("still underlines its terms but offers no 存進名詞表", async () => {
    // Arrange
    const client = mock();
    await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "A copy-on-write filesystem." });
    await client.archiveLine(NAS_ROOT_ID);
    show(client);
    const row = await zfsReply();

    // Act
    await waitFor(() => expect(document.querySelector("[data-tg-term-mark]")).not.toBeNull(), { timeout: 4000 });
    fireEvent.pointerEnter(row.querySelector("[data-tg-message]")!);
    const more = (await within(row).findAllByRole("button", { name: "More actions" })).find((button) => button.getAttribute("aria-haspopup") === "menu");

    // Assert
    if (more) {
      await userEvent.click(more);
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).not.toContain("Save to glossary");
    }
  });
});

describe("an answered aside's 存進名詞表 (the full view's wrap-up)", () => {
  it("is a main choice while the glossary is on, hands the frame a save from the aside, and is absent while it is off", async () => {
    // Arrange
    const client = mock();
    const { onFlow } = show(client, "nas-b1a");
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 4000 });

    // Act
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Save to glossary" }));

    // Assert
    expect(onFlow).toHaveBeenLastCalledWith({ kind: "saveTerm", lineId: "nas-b1a" });
    cleanup();
    show(mock(["glossary"]), "nas-b1a");
    const without = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 4000 });
    expect(within(without).queryByRole("button", { name: "Save to glossary" })).toBeNull();
  });
});

describe("GlossaryFlow: what the frame does with a save", () => {
  function host(client: MockTangentClient, flow: Extract<BranchFlow, { kind: "saveTerm" | "askedBefore" }>) {
    const close = vi.fn();
    const toast = vi.fn();
    const onShowGlossary = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TangentProvider client={client} locale="en">
          <GlossaryFlow flow={flow} close={close} toast={toast} onShowGlossary={onShowGlossary} />
        </TangentProvider>
      </QueryClientProvider>,
    );
    return { close, toast, onShowGlossary };
  }

  it("saves the aside's term, says so with 查看, and 查看 shows the term in the side panel", async () => {
    // Arrange
    const client = mock();
    const { close, toast, onShowGlossary } = host(client, { kind: "saveTerm", lineId: "nas-b1a" });
    const dialog = await screen.findByRole("dialog", { name: "Save to glossary" }, { timeout: 4000 });
    expect(within(dialog).getByRole("textbox", { name: "Term" })).toHaveValue("scrub 多久跑一次？");

    // Act
    await userEvent.click(within(dialog).getByRole("button", { name: "Save to glossary" }));

    // Assert
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Saved to the glossary.", expect.objectContaining({ label: "View" })));
    expect(close).toHaveBeenCalled();
    const [term] = (await client.listTerms(NAS_ROOT_ID)).terms;
    act(() => toast.mock.calls.at(-1)?.[1]?.run());
    expect(onShowGlossary).toHaveBeenCalledWith(term!.id);
    // Saving from the aside kept it.
    expect((await client.getBranch("nas-b1a")).branch.keptAt).toEqual(expect.any(String));
  });

  it("opens what 「之前問過」 found and copies it to this conversation", async () => {
    // Arrange
    const client = mock();
    const other = await client.createLine({ title: "儲存筆記" });
    const made = await client.createTerm(other.id, { term: "ZFS", explanation: "The explanation from before." });
    const hit: TermSearchHit = { ...made.term, rootTitle: "儲存筆記" };
    const { toast } = host(client, { kind: "askedBefore", lineId: NAS_ROOT_ID, hit });
    const dialog = await screen.findByRole("dialog", { name: "You asked about “ZFS” before" }, { timeout: 4000 });

    // Act
    await userEvent.click(within(dialog).getByRole("button", { name: "Copy to this conversation's glossary" }));

    // Assert
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Copied to this conversation's glossary."));
    expect((await client.listTerms(NAS_ROOT_ID)).terms.map((term) => term.explanation)).toEqual(["The explanation from before."]);
  });
});
