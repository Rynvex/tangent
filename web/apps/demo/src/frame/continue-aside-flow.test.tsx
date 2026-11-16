// @vitest-environment jsdom
import { TangentError, type TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContinueAsideFlow from "./continue-aside-flow";
import { expectedGone } from "./expected-gone";

/** F18 §2.1 接著問: straight to the new branch when it goes through; a refusal is said, with a way on. */

const mocks: MockTangentClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  expectedGone.clear();
});

async function setup(prepare?: (client: MockTangentClient, asideId: string) => Promise<void> | void) {
  const client = createMockTangentClient({ latencyMs: 0, chunkMs: 1 });
  mocks.push(client);
  const made = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "What is a scrub?", kind: "aside" });
  await client.sendMessage(made.line.id, { content: "What is a scrub?" });
  await waitFor(async () => expect((await client.getBranch(made.line.id)).branch.status).toBe("discarded"));
  await prepare?.(client, made.line.id);
  const spies = { close: vi.fn(), navigate: vi.fn(), toast: vi.fn(), openFlow: vi.fn() };
  const show = (lineId = made.line.id) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
        <TangentProvider client={client as TangentClient} locale="en">
          <ContinueAsideFlow lineId={lineId} {...spies} />
        </TangentProvider>
      </QueryClientProvider>,
    );
  return { client, asideId: made.line.id, spies, show };
}

describe("ContinueAsideFlow", () => {
  it("goes to the new branch with no dialog, and the aside's line is expected to go only while it runs", async () => {
    const { client, asideId, spies, show } = await setup();
    const original = client.continueAside.bind(client);
    const expectedWhileRunning: boolean[] = [];
    const continueAside = vi.spyOn(client, "continueAside").mockImplementation((lineId, input, opts) => {
      expectedWhileRunning.push(expectedGone.has(lineId));
      return original(lineId, input, opts);
    });
    show();
    await waitFor(() => expect(spies.navigate).toHaveBeenCalledTimes(1));
    expect(expectedWhileRunning).toEqual([true]);
    const newLineId = spies.navigate.mock.calls[0]![0] as string;
    expect(newLineId).not.toBe(asideId);
    expect((await client.getLine(newLineId)).conversationBranch).toMatchObject({ kind: "investigate", status: "open" });
    expect((await client.listMessages(newLineId)).messages.map((message) => message.content)).toEqual(expect.arrayContaining(["What is a scrub?"]));
    expect(spies.close).toHaveBeenCalledTimes(1);
    expect(expectedGone.has(asideId)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Asked once (StrictMode or a re-render must not ask again).
    expect(continueAside).toHaveBeenCalledTimes(1);
  });

  it("refused because the line above is full: says so and keeps the older way open (an investigate branch from the same place)", async () => {
    const { client, asideId, spies, show } = await setup(async (mock) => {
      const open = mock.mock.snapshot().branches.filter((branch) => branch.parentLineId === NAS_ROOT_ID && branch.status === "open").length;
      for (let i = open; i < 8; i += 1) await mock.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: `open ${i}`, kind: "investigate" });
    });
    show();
    const dialog = await screen.findByRole("dialog", { name: "Could not keep asking" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The line above already has 8 open branches.");
    expect(spies.navigate).not.toHaveBeenCalled();
    expect(expectedGone.has(asideId)).toBe(false);
    // The aside is as it was.
    expect((await client.getBranch(asideId)).branch).toMatchObject({ kind: "aside", status: "discarded" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Open an investigate branch instead" }));
    expect(spies.openFlow).toHaveBeenCalledWith({
      kind: "open",
      lineId: NAS_ROOT_ID,
      request: expect.objectContaining({ anchorMessageId: "nas-m17", purpose: "What is a scrub?", question: "", excerpt: expect.any(String) }),
    });
  });

  it("a deeper branch is asked about first; 還是要接著問 sends it again with the confirmation", async () => {
    const { client, spies, show } = await setup();
    const continueAside = vi.spyOn(client, "continueAside");
    continueAside.mockRejectedValueOnce(new TangentError(409, "deeper than suggested", "depth_soft_limit", { depth: 4, limit: 3 }));
    show();
    const dialog = await screen.findByRole("dialog", { name: "Could not keep asking" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The branch would be level 4; past level 3 a conversation gets hard to follow.");
    expect(within(dialog).queryByRole("button", { name: "Open an investigate branch instead" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep asking anyway" }));
    await waitFor(() => expect(spies.navigate).toHaveBeenCalledTimes(1));
    expect(continueAside.mock.calls.map(([, input]) => input)).toEqual([undefined, { confirmDeeper: true }]);
    expect(spies.close).toHaveBeenCalled();
  });

  it("a change at the same moment can be tried again", async () => {
    const { client, spies, show } = await setup();
    vi.spyOn(client, "continueAside").mockRejectedValueOnce(new TangentError(409, "changed", "concurrent_change"));
    show();
    const dialog = await screen.findByRole("dialog", { name: "Could not keep asking" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(spies.navigate).toHaveBeenCalledTimes(1));
  });

  it("an aside that is no longer there is said in passing: no dialog, nothing left to act on", async () => {
    const { spies, show } = await setup();
    show("no-such-aside");
    await waitFor(() => expect(spies.toast).toHaveBeenCalledWith("This quick question is no longer there."));
    expect(spies.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(expectedGone.size).toBe(0);
  });
});
