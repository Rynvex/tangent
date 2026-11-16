// @vitest-environment jsdom
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationView } from "./conversation-view";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

const QUESTION = "What does --fast-list do? [fake:error]";

/** A branch of the given kind whose first turn failed: an aside stays open (and writable) until it is answered. */
async function show(kind: "aside" | "investigate") {
  const client = createMockTangentClient({ latencyMs: 0, chunkMs: 1, scenario: nasScenario() });
  mocks.push(client);
  const created = await client.createBranch(NAS_ROOT_ID, { purpose: "What does --fast-list do", kind, anchorMessageId: "nas-m40" });
  await client.sendMessage(created.line.id, { content: QUESTION });
  const onFlow = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other" target="window">
          <ConversationView
            lineId={created.line.id}
            draft=""
            onDraftChange={() => {}}
            forcedBanner={null}
            focus={null}
            onFlow={onFlow}
            navigate={() => {}}
            onPreview={() => {}}
            toast={() => {}}
            onMemo={() => Promise.resolve(true)}
          />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  await screen.findByText(/the fake runner was told to fail/, {}, { timeout: 3000 });
  const matches = await screen.findAllByText(QUESTION, {}, { timeout: 3000 });
  const question = matches.find((element) => element.closest("[data-message-id]"));
  if (!question) throw new Error(`the question is not in the thread: ${matches.map((element) => element.tagName).join(", ")}`);
  return { onFlow, question };
}

/** A message's actions are built the first time it is pointed at. */
function armActions(question: HTMLElement): HTMLElement {
  const article = question.closest("[data-message-id]") as HTMLElement;
  fireEvent.pointerEnter(article.querySelector("[data-tg-message]")!);
  return article;
}

function selectIn(node: Node) {
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, 4);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => {
    fireEvent(document, new Event("selectionchange"));
  });
}

describe("inside an aside nothing forks (F11 §1)", () => {
  it("offers no 開支線, 秒問解釋 or 修改並分岔 while the aside is open; the selection still offers the notes and the memo", async () => {
    const { onFlow, question } = await show("aside");
    const article = armActions(question);
    expect(await within(article).findByRole("button", { name: "Copy message" })).toBeInTheDocument();
    expect(within(article).queryByRole("button", { name: /Edit and branch/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a branch" })).toBeNull();
    selectIn(question.firstChild!);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    expect(within(toolbar).queryByRole("button", { name: "Branch from this" })).toBeNull();
    expect(within(toolbar).queryByRole("button", { name: "Quick ask" })).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Save to notes" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Save as a memo" })).toBeInTheDocument();
    // ⌘B opens nothing either.
    act(() => {
      fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    });
    expect(onFlow).not.toHaveBeenCalled();
  });

  it("keeps every forking action in an investigate branch", async () => {
    const { onFlow, question } = await show("investigate");
    const article = armActions(question);
    expect(await within(article).findByRole("button", { name: /Edit and branch/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open a branch" })).toBeInTheDocument();
    selectIn(question.firstChild!);
    const toolbar = await screen.findByRole("toolbar", { name: "Selected text" });
    expect(within(toolbar).getByRole("button", { name: "Branch from this" })).toBeInTheDocument();
    expect(within(toolbar).getByRole("button", { name: "Quick ask" })).toBeInTheDocument();
    window.getSelection()?.removeAllRanges();
    act(() => {
      fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    });
    expect(onFlow).toHaveBeenCalledWith(expect.objectContaining({ kind: "open" }));
  });
});
