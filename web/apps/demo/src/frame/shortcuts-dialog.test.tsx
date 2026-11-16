// @vitest-environment jsdom
import type { TangentClient } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider, type BindingOverrides } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ShortcutsDialog } from "./shortcuts-dialog";

/** F8 S4: 快捷鍵說明. */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function Host() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <ShortcutsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function setup(bindings: BindingOverrides = {}) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario() });
  mocks.push(client);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TangentProvider client={client as TangentClient} locale="zh-TW">
        <ShortcutsProvider platform="apple" bindings={bindings}>
          <Host />
        </ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>,
  );
}

describe("ShortcutsDialog", () => {
  it("lists the keys in four groups with focus on the close button", async () => {
    setup();
    const dialog = await screen.findByRole("dialog", { name: "快捷鍵" });
    const groups = within(dialog).getAllByRole("region");
    expect(groups.map((group) => group.getAttribute("aria-labelledby") && within(group).getByRole("heading").textContent)).toEqual(["導覽", "支線", "紀要與停車", "專注模式"]);
    expect(within(groups[1]!).getByText("開支線").closest("div")).toHaveTextContent("⌘B");
    expect(within(groups[0]!).getByText("在對話內搜尋").closest("div")).toHaveTextContent("⌘F");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "關閉" })).toHaveFocus());
    // Palette-only commands have no keys and are not listed.
    expect(within(dialog).queryByText("匯出對話…")).toBeNull();
  });

  it("marks the keys Firefox keeps and points to the command palette", async () => {
    setup();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("送出前預覽").closest("div")).toHaveTextContent("Firefox 不可用");
    expect(within(dialog).getByText("開支線").closest("div")).not.toHaveTextContent("Firefox 不可用");
    expect(within(dialog).getByText(/請改用命令面板（⌘K）/)).toBeInTheDocument();
  });

  it("shows a host's own keys and leaves out the keys it turned off", async () => {
    setup({ "branch.open": "Mod+Shift+B", "focus.toggle": null, "turn.preview": null, "structure.toggleView": null, "composer.park": null });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("開支線").closest("div")).toHaveTextContent("⌘⇧B");
    expect(within(dialog).queryByText("進入或離開專注模式")).toBeNull();
    expect(within(dialog).queryByRole("heading", { name: "專注模式" })).toBeNull();
    expect(within(dialog).queryByText(/請改用命令面板/)).toBeNull();
  });

  it("closes on Esc", async () => {
    setup();
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
