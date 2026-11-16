import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { useCapabilities } from "../data/queries";
import { useQuickAsk } from "./quick-ask";

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

async function setup(features: "all" | "core" = "all") {
  const client = mockClient({ scenario: nasScenario({ features }) });
  clients.push(client);
  const create = vi.spyOn(client, "createBranch");
  const send = vi.spyOn(client, "sendMessage");
  const hook = renderHook(() => ({ quick: useQuickAsk(NAS_ROOT_ID), capabilities: useCapabilities() }), { wrapper: tangentWrapper(client) });
  // The kind (aside or investigate) follows the capabilities.
  await waitFor(() => expect(hook.result.current.capabilities.isSuccess).toBe(true));
  return { client, create, send, result: { get current() { return hook.result.current.quick; } } };
}

describe("useQuickAsk (F10 ⚡ 秒問解釋)", () => {
  it("opens an aside from a selected term and sends its explain question there", async () => {
    const { create, send, result } = await setup();
    const outcome = await result.current.ask({ messageId: "nas-m17", text: "「RAID-Z」", forkable: true });
    expect("created" in outcome).toBe(true);
    expect(create.mock.calls[0]![1]).toEqual({ purpose: "About: RAID-Z", kind: "aside", anchorMessageId: "nas-m17", excerpt: "「RAID-Z」" });
    const lineId = "created" in outcome ? outcome.created.line.id : "";
    expect(send).toHaveBeenCalledWith(lineId, { content: "What is “RAID-Z”? Explain it simply, with one example." });
  });

  it("asks why for a sentence, with its start as the purpose", async () => {
    const { create, send, result } = await setup();
    await result.current.ask({ messageId: "nas-m17", text: "兩者都容許壞一顆碟。差別在擴充方式與重建風險", forkable: true });
    expect(create.mock.calls[0]![1]).toMatchObject({ purpose: "Check: 兩者都容許壞一顆碟。差別在擴充方式與重建風險" });
    expect(send.mock.calls[0]![1]).toEqual({ content: "Why “兩者都容許壞一顆碟。差別在擴充方式與重建風險”? Explain the reasoning behind it in detail." });
  });

  it("uses an investigate branch while asides are off", async () => {
    const { create, result } = await setup("core");
    await result.current.ask({ messageId: "nas-m17", text: "CAP", forkable: true });
    expect(create.mock.calls[0]![1]).toMatchObject({ kind: "investigate" });
  });
});
