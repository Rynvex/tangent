import { normalizeSuggestion, type Capabilities } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { DriftHint } from "./drift-hint";

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

const off = (capabilities: Capabilities, ...names: string[]): Capabilities => ({
  ...capabilities,
  features: capabilities.features.map((feature) => (names.includes(feature.name) ? { name: feature.name, enabled: false } : feature)),
});

async function setup({ readOnly = false, features }: { readOnly?: boolean; features?: (capabilities: Capabilities) => Capabilities } = {}) {
  const scenario = nasScenario();
  if (features) scenario.capabilities = features(scenario.capabilities);
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = mockClient({ scenario });
  clients.push(client);
  await client.sendMessage(NAS_ROOT_ID, { content: "[fake:drift] remote access?" });
  for (let i = 0; i < 300 && (await client.getLine(NAS_ROOT_ID)).status === "thinking"; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const drift = (await client.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.kind === "drift");
  return { client, drift: drift ?? normalizeSuggestion({}) };
}

describe("DriftHint (C4: under the reply, at most one per turn, never a popup)", () => {
  it("asks quietly, without taking focus, and opens the proposed branch kind (an aside here)", async () => {
    const { client, drift: proposed } = await setup();
    // The server proposes an aside only while asides are on; the fake runner always proposes an investigation.
    const drift = { ...proposed, payload: { ...proposed.payload, kind: "aside" } };
    const onOpened = vi.fn();
    const before = document.activeElement;
    render(<DriftHint rootLineId={NAS_ROOT_ID} suggestion={drift} onOpened={onOpened} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const hint = screen.getByRole("group", { name: "偏離目標" });
    expect(hint).toHaveTextContent("這段好像偏離目標（It moved away from the goal (fake runner).），要開成岔題嗎？");
    expect(document.activeElement).toBe(before);
    expect(hint.closest("[role=dialog]")).toBeNull();
    await userEvent.click(await within(hint).findByRole("button", { name: "開成順口問" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    const lineId = onOpened.mock.calls[0]![0] as string;
    expect((await client.getBranch(lineId)).branch).toMatchObject({ kind: "aside", anchorMessageId: String(proposed.payload.anchorMessageId) });
  });

  it("without asides it offers an investigation; 不用 dismisses it", async () => {
    const { client, drift } = await setup({ features: (capabilities) => off(capabilities, "aside") });
    render(<DriftHint rootLineId={NAS_ROOT_ID} suggestion={drift} onOpened={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    const hint = screen.getByRole("group", { name: "偏離目標" });
    await within(hint).findByRole("button", { name: "停車" });
    expect(within(hint).queryByRole("button", { name: "開成順口問" })).toBeNull();
    // Keyboard: the actions are buttons in order.
    within(hint).getByRole("button", { name: "開成查證" }).focus();
    await userEvent.tab();
    await userEvent.tab();
    expect(within(hint).getByRole("button", { name: "不用" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(async () => expect((await client.listSuggestions(NAS_ROOT_ID, { status: "all" })).suggestions.find((item) => item.id === drift.id)?.status).toBe("dismissed"));
  });

  it("停車 parks the side topic and puts the hint away (parking on)", async () => {
    const { client, drift } = await setup();
    render(<DriftHint rootLineId={NAS_ROOT_ID} suggestion={drift} onOpened={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    await userEvent.click(await screen.findByRole("button", { name: "停車" }));
    await waitFor(async () => expect((await client.listSeeds(NAS_ROOT_ID)).seeds.some((seed) => seed.text === "Follow the side topic (fake runner)")).toBe(true));
    expect((await client.listSuggestions(NAS_ROOT_ID, { status: "all" })).suggestions.find((item) => item.id === drift.id)?.status).toBe("dismissed");
  });

  it("without parking there is no 停車; a viewer sees the hint with no actions", async () => {
    const { client, drift } = await setup({ features: (capabilities) => off(capabilities, "parking") });
    render(<DriftHint rootLineId={NAS_ROOT_ID} suggestion={drift} onOpened={vi.fn()} />, { wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) });
    await screen.findByRole("button", { name: "開成查證" });
    expect(screen.queryByRole("button", { name: "停車" })).toBeNull();
    cleanup();
    const viewer = await setup({ readOnly: true });
    render(<DriftHint rootLineId={NAS_ROOT_ID} suggestion={viewer.drift} onOpened={vi.fn()} />, { wrapper: tangentWrapper(viewer.client, undefined, { locale: "zh-TW" }) });
    await waitFor(() => expect(screen.queryAllByRole("button")).toHaveLength(0));
    expect(screen.getByRole("group", { name: "偏離目標" })).toBeInTheDocument();
  });
});
