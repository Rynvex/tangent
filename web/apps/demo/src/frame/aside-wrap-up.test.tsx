// @vitest-environment jsdom
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

/** nas-b1a: an answered aside under nas-b1. `features` "c1-no-aside": notes and memos on, asides off. */
function show(features: "all" | "c1-no-aside" = "all") {
  const scenario = nasScenario();
  const capabilities = features === "all" ? scenario.capabilities : { ...scenario.capabilities, features: scenario.capabilities.features.map((feature) => (feature.name === "aside" ? { ...feature, enabled: false } : feature)) };
  const client = createMockTangentClient({ latencyMs: 0, scenario: { ...scenario, capabilities } });
  mocks.push(client);
  const navigate = vi.fn();
  const onFlow = vi.fn();
  const toast = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider>
          <ConversationView lineId="nas-b1a" draft="" onDraftChange={() => {}} forcedBanner={null} focus={null} onFlow={onFlow} navigate={navigate} onPreview={() => {}} toast={toast} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { client, navigate, onFlow, toast };
}

describe("an answered aside's ways on (F10 §4.3)", () => {
  it("keeps the answer in the notes and goes back to the line above", async () => {
    const { client, navigate, toast } = show();
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Keep it in the notes and go back" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("nas-b1", expect.any(String)));
    expect(toast).toHaveBeenCalledWith("Kept in the notes.");
    const notes = (await client.listNotes(NAS_ROOT_ID)).notes;
    expect(notes.some((note) => note.sourceLineId === "nas-b1a" && note.text.startsWith("scrub 多久跑一次？："))).toBe(true);
  });

  it("saves it as a memo on the line above", async () => {
    const { client, navigate } = show();
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Save as a memo and go back" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect((await client.listMemos(NAS_ROOT_ID)).memos.some((memo) => memo.lineId === "nas-b1")).toBe(true);
  });

  // F18 §2.1: 「還想追問（從這裡開查證支線）」 was replaced by 接著問 (the aside itself becomes the branch).
  it("keeps asking (the aside becomes a branch: the frame's flow), or just goes back", async () => {
    const { navigate, onFlow } = show();
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    expect(within(wrapUp).queryByRole("button", { name: "Ask more (an investigate branch from here)" })).toBeNull();
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Keep asking" }));
    expect(onFlow).toHaveBeenCalledWith({ kind: "continueAside", lineId: "nas-b1a" });
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Just go back" }));
    expect(navigate).toHaveBeenCalledWith("nas-b1", "nas-b1-3");
  });

  it("with asides off, the older way stays: an investigate branch from the aside's fork point (no 保留, no 接著問)", async () => {
    const { onFlow } = show("c1-no-aside");
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    expect(within(wrapUp).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(within(wrapUp).queryByRole("button", { name: "Keep asking" })).toBeNull();
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Ask more (an investigate branch from here)" }));
    expect(onFlow).toHaveBeenCalledWith(expect.objectContaining({ kind: "open", lineId: "nas-b1", request: expect.objectContaining({ anchorMessageId: "nas-b1-3", purpose: "scrub 多久跑一次？", question: "" }) }));
    // Throwing it away is core: still offered.
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Throw away" }));
    expect(onFlow).toHaveBeenLastCalledWith({ kind: "deleteBranch", lineId: "nas-b1a" });
  });

  it("keeps the aside and lets it go again: the line under the title and the button follow", async () => {
    const { client, toast } = show();
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    expect(wrapUp.querySelector("[data-tg-aside-fate]")?.textContent).toMatch(/Cleared in \d+ day/);
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(wrapUp.querySelector("[data-tg-aside-fate]")?.textContent).toBe("Kept: it will not be cleared."));
    expect((await client.getBranch("nas-b1a")).branch.keptAt).toEqual(expect.any(String));
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Stop keeping" }));
    await waitFor(() => expect(within(wrapUp).getByRole("button", { name: "Keep" })).toBeTruthy());
    expect("keptAt" in (await client.getBranch("nas-b1a")).branch).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("saving the answer keeps the aside too (saved means wanted)", async () => {
    const { client, navigate } = show();
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Keep it in the notes and go back" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    await waitFor(async () => expect((await client.getBranch("nas-b1a")).branch.keptAt).toEqual(expect.any(String)));
  });

  it("throws it away through the frame's delete host (it owns the wait and the undo)", async () => {
    const { onFlow } = show();
    const wrapUp = await screen.findByRole("region", { name: "Answered. What next?" }, { timeout: 3000 });
    await userEvent.click(within(wrapUp).getByRole("button", { name: "Throw away" }));
    expect(onFlow).toHaveBeenCalledWith({ kind: "deleteBranch", lineId: "nas-b1a" });
  });
});
