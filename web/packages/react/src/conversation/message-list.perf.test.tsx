import { normalizeMessage, type Message } from "@tangent/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTangent } from "../provider";
import { mockClient, tangentWrapper } from "../test-utils";
import { MessageList } from "./message-list";

/** Counts Markdown renders per text, the expensive part of a finished row. */
const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("../markdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    renders.set(children, (renders.get(children) ?? 0) + 1);
    return <div>{children}</div>;
  },
}));

afterEach(() => {
  cleanup();
  renders.clear();
});

const ROWS = 2000;
const DELTAS = 500;

function messages(): Message[] {
  const finished = Array.from({ length: ROWS }, (_, i) =>
    normalizeMessage({ id: `m${i}`, seq: i + 1, lineId: "l1", role: i % 2 ? "assistant" : "user", status: "done", content: `message ${i}` }),
  );
  return [...finished, normalizeMessage({ id: "p", seq: ROWS + 1, lineId: "l1", role: "assistant", status: "pending", content: "" })];
}

describe("MessageList performance (review M3)", () => {
  it("streams 500 deltas into a 2000-message list without re-rendering a finished row", async () => {
    const client = mockClient();
    vi.spyOn(client, "getStream").mockResolvedValue({ deltas: [], seq: 0, truncated: false });
    const list = messages();
    let live: ReturnType<typeof useTangent>["live"] | null = null;
    function Harness({ onParentRender }: { onParentRender: () => void }) {
      live = useTangent().live;
      onParentRender();
      // Inline handlers on purpose: the list must not re-render rows because of them.
      return <MessageList lineId="l1" messages={list} onBranch={() => undefined} onRetry={() => undefined} />;
    }
    const parentRenders = vi.fn();
    const { rerender } = render(<Harness onParentRender={parentRenders} />, { wrapper: tangentWrapper(client) });
    const finishedText = "message 1";
    expect(renders.get(finishedText)).toBe(1);

    const started = performance.now();
    for (let i = 0; i < DELTAS; i += 1) {
      act(() => live!.addDeltas("l1", [{ turnId: "p", seq: i + 1, kind: "text", text: "x" }]));
    }
    const elapsed = performance.now() - started;
    rerender(<Harness onParentRender={parentRenders} />);

    expect(renders.get(finishedText)).toBe(1);
    expect(renders.get("message 1999")).toBe(1);
    expect(screen.getByText("x".repeat(DELTAS))).toBeInTheDocument();
    console.info(`stream perf: ${DELTAS} deltas into ${ROWS} rows in ${elapsed.toFixed(0)} ms`);
    client.mock.dispose();
  });
});
