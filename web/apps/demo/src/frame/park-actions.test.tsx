// @vitest-environment jsdom
import { TangentError, normalizeMessage } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useParkActions, type ParkActions } from "./park-actions";

afterEach(cleanup);

let actions: ParkActions | null = null;
let draft = "";

function Host({ toast, enabled }: { toast: (message: string) => void; enabled: boolean }) {
  const [value, setValue] = useState(draft);
  draft = value;
  actions = useParkActions("nas", enabled, value, setValue, toast);
  return <p>{value}</p>;
}

function setup(initial = "", enabled = true) {
  draft = initial;
  actions = null;
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  const create = vi.spyOn(client, "createSeed");
  const toast = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other" target="window">
          <Host toast={toast} enabled={enabled} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { create, toast, client };
}

const parkShortcut = () =>
  act(() => {
    fireEvent.keyDown(document.body, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
  });

describe("停車 (B3): three ways in, ⌘⇧S included", () => {
  it("⌘⇧S parks the composer's text and empties the composer", async () => {
    const { create, toast } = setup("Is a UPS worth it?");
    parkShortcut();
    await waitFor(() => expect(create).toHaveBeenCalledWith("nas", { text: "Is a UPS worth it?" }));
    await waitFor(() => expect(draft).toBe(""));
    expect(toast).toHaveBeenCalledWith("Parked · costs no tokens");
  });

  it("pressing ⌘⇧S twice while the first is on its way parks once (R7 D3)", async () => {
    const { create, toast } = setup("Is a UPS worth it?");
    parkShortcut();
    parkShortcut();
    await waitFor(() => expect(draft).toBe(""));
    expect(create).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("an empty composer parks nothing and says what to do", () => {
    const { create, toast } = setup("   ");
    parkShortcut();
    expect(create).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Write the thought in the composer first, then park it.");
  });

  it("refuses a composer text over 500 characters and keeps it", () => {
    const { create, toast } = setup("x".repeat(501));
    parkShortcut();
    expect(create).not.toHaveBeenCalled();
    expect(draft).toHaveLength(501);
    expect(toast).toHaveBeenCalledWith("A seed is at most 500 characters; shorten it before parking.");
  });

  it("parks a message (its start) and a selection, each with its message as the source", async () => {
    const { create } = setup();
    const message = normalizeMessage({ id: "nas-m40", lineId: "nas", role: "assistant", content: `Back up\n\n${"long ".repeat(60)}` });
    act(() => actions?.onParkMessage(message));
    await waitFor(() => expect(create).toHaveBeenLastCalledWith("nas", { text: expect.stringMatching(/^Back up long/), anchorMessageId: "nas-m40" }));
    expect(Array.from(create.mock.calls[0]![1].text).length).toBeLessThanOrEqual(120);
    act(() => actions?.onParkSelection({ messageId: "nas-m17", text: "RAIDZ1 rebuilds read every disk", forkable: true }));
    await waitFor(() => expect(create).toHaveBeenLastCalledWith("nas", { text: "RAIDZ1 rebuilds read every disk", anchorMessageId: "nas-m17" }));
  });

  it("keeps the composer text when the server refuses, and says why", async () => {
    const { client, toast } = setup("One more idea");
    vi.spyOn(client, "createSeed").mockRejectedValue(new TangentError(409, "full", "seed_limit", { limit: 100 }));
    parkShortcut();
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Not parked: The parking lot is full \(100 seeds\)/)));
    expect(draft).toBe("One more idea");
  });

  it("is off with the parking feature: no actions, ⌘⇧S does nothing", () => {
    const { create, toast } = setup("text", false);
    expect(actions).toBeNull();
    parkShortcut();
    expect(create).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
