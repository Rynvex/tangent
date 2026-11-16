// @vitest-environment jsdom
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBranchCommands, useBranchHere } from "./branch-commands";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

type Open = (anchorMessageId: string | undefined, extra?: { excerpt?: string }) => void;

function Thread({ openBranch, toast }: { openBranch: Open; toast: (message: string) => void }) {
  const ref = useRef<HTMLOListElement>(null);
  const branchHere = useBranchHere(ref, "nas-m40", openBranch, toast);
  useBranchCommands({ line: null, readOnly: false, onBranch: branchHere, navigate: () => undefined, onFlow: () => undefined });
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
  const openBranch = vi.fn<Open>();
  const toast = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other" target="window">
          <Thread openBranch={openBranch} toast={toast} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { openBranch, toast };
}

function select(node: Node, start: number, end: number, endNode: Node = node): void {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

const branchShortcut = () =>
  act(() => {
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
  });

describe("⌘B with a selection (R5)", () => {
  it("branches from a selection inside one message", () => {
    const { openBranch, toast } = setup();
    select(screen.getByText(/^About/).firstChild!, 6, 11);
    branchShortcut();
    expect(openBranch).toHaveBeenCalledWith("nas-m9", { excerpt: "2.1TB" });
    expect(toast).not.toHaveBeenCalled();
  });

  it("opens nothing for a selection in a conclusion card, and says a branch cannot start there", () => {
    const { openBranch, toast } = setup();
    select(screen.getByText(/^Card:/).firstChild!, 6, 16);
    branchShortcut();
    expect(openBranch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("A branch cannot start from a conclusion card or a move marker.");
  });

  it("opens nothing for a selection across messages or outside the thread, and asks for one message", () => {
    const { openBranch, toast } = setup();
    select(screen.getByText(/^About/).firstChild!, 0, 5, screen.getByText(/^Card:/).firstChild!);
    branchShortcut();
    select(screen.getByText("Outside the thread").firstChild!, 0, 7);
    branchShortcut();
    expect(openBranch).not.toHaveBeenCalled();
    expect(toast.mock.calls).toEqual([["Select text within one message."], ["Select text within one message."]]);
  });

  it("branches from the last message when nothing is selected", () => {
    const { openBranch, toast } = setup();
    branchShortcut();
    expect(openBranch).toHaveBeenCalledWith("nas-m40");
    expect(toast).not.toHaveBeenCalled();
  });
});
