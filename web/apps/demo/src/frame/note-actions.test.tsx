// @vitest-environment jsdom
import type { Message } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNoteActions } from "./note-actions";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

const LAST_REPLY = { id: "nas-m40", content: "The last reply." } as Message;

function Thread({ toast }: { toast: (message: string) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  useNoteActions("nas", true, ref, LAST_REPLY, toast);
  return (
    <>
      <ol ref={ref}>
        <li data-message-id="nas-m9" data-forkable="true">
          <p>About 2.1TB of data today.</p>
        </li>
        <li data-message-id="nas-c1" data-forkable="false">
          <p>Card: ZFS mirror survives one failed disk.</p>
        </li>
      </ol>
      <p>Outside the thread</p>
    </>
  );
}

function setup() {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  const create = vi.spyOn(client, "createNote");
  const toast = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other" target="window">
          <Thread toast={toast} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { create, toast };
}

function select(node: Node, start: number, end: number, endNode: Node = node): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

const saveShortcut = () =>
  act(() => {
    fireEvent.keyDown(document.body, { key: "N", code: "KeyN", ctrlKey: true, shiftKey: true });
  });

describe("⌘⇧N 記進紀要 (R5)", () => {
  it("saves the text selected in a conclusion card, with the card as its source", async () => {
    const { create, toast } = setup();
    select(screen.getByText(/^Card:/).firstChild!, 6, 16);
    saveShortcut();
    await waitFor(() => expect(create).toHaveBeenCalledWith("nas", { section: "to_confirm", text: "ZFS mirror", sourceMessageId: "nas-c1" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Saved to the notes/)));
  });

  it("saves nothing and says why when the selection spans messages or leaves the thread", () => {
    const { create, toast } = setup();
    select(screen.getByText(/^About/).firstChild!, 0, 5, screen.getByText(/^Card:/).firstChild!);
    saveShortcut();
    expect(toast).toHaveBeenLastCalledWith("Select text within one message.");
    select(screen.getByText("Outside the thread").firstChild!, 0, 7);
    saveShortcut();
    expect(toast).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it("saves the last reply when nothing is selected", async () => {
    const { create } = setup();
    saveShortcut();
    await waitFor(() => expect(create).toHaveBeenCalledWith("nas", { section: "to_confirm", text: "The last reply.", sourceMessageId: "nas-m40" }));
  });
});
