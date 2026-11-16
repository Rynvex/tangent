// @vitest-environment jsdom
import type { TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ASIDE_DEFAULT_KEY, keepsAsides, type AsideDefaultStorage } from "./aside-default";
import { createAsideDefaultStore } from "./aside-default-store";
import { ConversationMenu } from "./conversation-menu";
import { createPinnedStore } from "./pinned-roots";

/** F18 §2.2: 「順口問預設：用完即丟｜保留」 in a conversation's menu, kept in this browser only. */

const mocks: MockTangentClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function fakeStorage(): AsideDefaultStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

async function open(options: { features?: "all" | "core"; archived?: boolean } = {}) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario({ features: options.features ?? "all" }) });
  mocks.push(client);
  const line = { ...(await client.getLine(NAS_ROOT_ID)), ...(options.archived ? { archivedAt: "2026-11-13T00:00:00Z" } : {}) };
  const storage = fakeStorage();
  const store = createAsideDefaultStore(() => storage);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TangentProvider client={client as TangentClient} locale="zh-TW">
        <ShortcutsProvider>
          <ConversationMenu line={line} onDelete={() => undefined} pinned={createPinnedStore(() => null)} asideDefault={store} />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
  const trigger = await screen.findByRole("button", { name: /家用 NAS 與備份策略/ });
  const openMenu = async () => {
    await userEvent.click(trigger);
    await screen.findByRole("menu");
  };
  return { storage, store, openMenu };
}

describe("順口問預設 in the conversation menu", () => {
  it("is a choice of two, 用完即丟 by default, and says it is remembered in this browser only", async () => {
    const { openMenu } = await open();
    await openMenu();
    const group = await screen.findByRole("group", { name: /順口問預設/ });
    expect(group).toHaveTextContent("只記在這個瀏覽器");
    const discard = await screen.findByRole("menuitemradio", { name: "用完即丟" });
    const keep = screen.getByRole("menuitemradio", { name: "保留" });
    expect(discard).toHaveAttribute("aria-checked", "true");
    expect(keep).toHaveAttribute("aria-checked", "false");
  });

  it("choosing 保留 is stored for this conversation (and only this one), and shows as chosen the next time", async () => {
    const { storage, openMenu } = await open();
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "保留" }));
    expect(JSON.parse(storage.data[ASIDE_DEFAULT_KEY]!)).toEqual([NAS_ROOT_ID]);
    expect(keepsAsides(NAS_ROOT_ID, storage)).toBe(true);
    expect(keepsAsides("osaka", storage)).toBe(false);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await openMenu();
    expect(await screen.findByRole("menuitemradio", { name: "保留" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "用完即丟" }));
    expect(keepsAsides(NAS_ROOT_ID, storage)).toBe(false);
  });

  it("is not offered while asides are off, nor on an archived conversation", async () => {
    const off = await open({ features: "core" });
    await off.openMenu();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    cleanup();
    const archived = await open({ archived: true });
    await archived.openMenu();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });
});
