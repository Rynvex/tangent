// @vitest-environment jsdom
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationView } from "./conversation-view";

beforeAll(() => {
  // jsdom has none; the view's stick-to-bottom hook observes its content.
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

async function show(lineId?: string) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  mocks.push(client);
  const id = lineId ?? (await client.createLine({ title: "New" })).id;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider>
          <ConversationView lineId={id} draft="" onDraftChange={() => {}} forcedBanner={null} focus={null} onFlow={() => {}} navigate={() => {}} onPreview={() => {}} toast={() => {}} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
}

describe("an empty conversation (F10 §4.4)", () => {
  it("shows the three tips under the empty text", async () => {
    await show();
    expect(await screen.findByText("No messages yet. Write the first one below.")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Getting started" })).toBeInTheDocument();
  });

  it("shows no tips once the line has messages", async () => {
    await show(NAS_ROOT_ID);
    expect(await screen.findAllByRole("article")).not.toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Getting started" })).toBeNull();
  });
});
