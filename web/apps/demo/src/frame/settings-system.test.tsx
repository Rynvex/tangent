// @vitest-environment jsdom
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelPrefsStore, EMPTY_MODEL_PREFS, MODEL_PREFS_KEY, withFavorite } from "./model-prefs";
import { createPrefsStore, DEFAULT_PREFS, PREFS_KEY, type PrefsStorage } from "./prefs";
import type { ClearableStorage, SettingsStores } from "./prefs-transfer";
import { AboutPanel, MaintenancePanel, type MaintenancePanelProps } from "./settings-system";

/** Settings → Maintenance and About (G2). */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function memory(initial: Record<string, string> = {}): PrefsStorage & ClearableStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => void (data[key] = value),
    get length() {
      return Object.keys(data).length;
    },
    key: (index) => Object.keys(data)[index] ?? null,
    removeItem: (key) => void delete data[key],
  };
}

function setup(props: Partial<MaintenancePanelProps> = {}, { readOnly = false, storage = memory() } = {}) {
  const scenario = nasScenario();
  const client = createMockTangentClient({ latencyMs: 0, scenario: { ...scenario, capabilities: { ...scenario.capabilities, permissions: { canWrite: !readOnly } } } });
  mocks.push(client);
  const stores: SettingsStores = { prefs: createPrefsStore(() => storage), models: createModelPrefsStore(() => storage) };
  const save = vi.fn();
  const reload = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TangentProvider client={client} locale="en">
        {children}
      </TangentProvider>
    </QueryClientProvider>
  );
  render(<MaintenancePanel stores={stores} save={save} storages={() => [storage]} reload={reload} {...props} />, { wrapper });
  return { stores, save, reload, storage };
}

const settingsFile = (content: string) => new File([content], "settings.json", { type: "application/json" });

describe("Settings → Maintenance: export and import", () => {
  it("exports every setting of this browser as a dated JSON file", async () => {
    const { stores, save } = setup();
    stores.prefs.update({ theme: "dark", codeWrap: true });
    stores.models.set(withFavorite(EMPTY_MODEL_PREFS, { provider: "fake", model: "fake-1" }, true));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(save).toHaveBeenCalledTimes(1);
    const [name, text] = save.mock.calls[0] as [string, string];
    expect(name).toMatch(/^tangent-settings-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(text)).toMatchObject({ kind: "tangent-settings", version: 1, prefs: { version: 2, theme: "dark", codeWrap: true }, modelPrefs: { version: 1, favorites: [{ provider: "fake", model: "fake-1" }] } });
    expect(screen.getByRole("status")).toHaveTextContent(`Saved as ${name}.`);
  });

  it("copies the same JSON to the clipboard", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Copied to the clipboard."));
    expect(JSON.parse(await navigator.clipboard.readText())).toMatchObject({ kind: "tangent-settings", prefs: { version: 2 } });
  });

  it("imports an exported file: both stores take its values and keep them", async () => {
    const user = userEvent.setup();
    const { stores, storage } = setup();
    const file = settingsFile(JSON.stringify({ kind: "tangent-settings", version: 1, prefs: { version: 2, theme: "dark", chatWidth: "wide", keybindings: { "branch.open": "Mod+Shift+L" } }, modelPrefs: { version: 1, defaultEffort: "high", favorites: [], hidden: [{ provider: "fake", model: "fake-1" }] } }));
    await user.upload(screen.getByLabelText("Settings file to import"), file);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Settings imported."));
    expect(stores.prefs.get()).toEqual({ ...DEFAULT_PREFS, theme: "dark", chatWidth: "wide", keybindings: { "branch.open": "Mod+Shift+L" } });
    expect(stores.models.get()).toEqual({ defaultEffort: "high", favorites: [], hidden: [{ provider: "fake", model: "fake-1" }] });
    expect(JSON.parse(storage.data[PREFS_KEY]!)).toMatchObject({ version: 2, theme: "dark" });
    expect(JSON.parse(storage.data[MODEL_PREFS_KEY]!)).toMatchObject({ version: 1, defaultEffort: "high" });
  });

  it("refuses a file that is not a settings export and says why; nothing changes", async () => {
    const user = userEvent.setup();
    const { stores } = setup();
    stores.prefs.update({ theme: "dark" });
    await user.upload(screen.getByLabelText("Settings file to import"), settingsFile("not json"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That file is not JSON."));
    await user.upload(screen.getByLabelText("Settings file to import"), settingsFile('{"theme":"light"}'));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That file is not a Tangent settings export."));
    await user.upload(screen.getByLabelText("Settings file to import"), settingsFile('{"kind":"tangent-settings","version":5}'));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("newer Tangent (format 5)"));
    expect(stores.prefs.get().theme).toBe("dark");
  });
});

describe("Settings → Maintenance: resets", () => {
  it("resets the local preferences after the second answer", async () => {
    const user = userEvent.setup();
    const { stores } = setup();
    stores.prefs.update({ theme: "dark", confirmDelete: false });
    stores.models.set(withFavorite(EMPTY_MODEL_PREFS, { provider: "fake", model: "fake-1" }, true));
    await user.click(screen.getByRole("button", { name: "Reset…" }));
    expect(stores.prefs.get().theme).toBe("dark");
    await user.click(within(screen.getByRole("group", { name: "Reset…" })).getByRole("button", { name: "Restore" }));
    expect(stores.prefs.get()).toEqual(DEFAULT_PREFS);
    expect(stores.models.get()).toEqual({ favorites: [], hidden: [] });
    expect(screen.getByRole("status")).toHaveTextContent("Every setting is back to its default.");
  });

  it("clears what else the browser remembers (never the settings), then reloads", async () => {
    const user = userEvent.setup();
    const storage = memory({ "tangent:pinned-roots:v1": '["nas"]', "tangent:side-width:v1": "420", "tangent-demo.focus": "{}", [PREFS_KEY]: '{"version":2,"theme":"dark"}', unrelated: "x" });
    const { reload } = setup({}, { storage });
    await user.click(screen.getByRole("button", { name: "Clear…" }));
    const question = screen.getByRole("group", { name: "Clear…" });
    expect(within(question).getByText("Clear 3 remembered item(s) and reload the page?")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Clear and reload" }));
    expect(Object.keys(storage.data).sort()).toEqual([PREFS_KEY, "unrelated"].sort());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says so when there is nothing to clear", () => {
    setup();
    expect(screen.getByText("There is nothing to clear.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear…" })).toBeNull();
  });
});

describe("Settings → Maintenance: connection, and About", () => {
  it("says what the page talks to, the event stream's state and the access", async () => {
    setup();
    expect(screen.getByText("In-browser mock (no server)")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Read and write")).toBeInTheDocument());
  });

  it("says read only for an identity that may not write", async () => {
    setup({}, { readOnly: true });
    await waitFor(() => expect(screen.getByText("Read only")).toBeInTheDocument());
  });

  it("About names the project, its version, licence and where to find it", () => {
    render(<AboutPanel />);
    expect(screen.getByRole("heading", { name: "Tangent" })).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MIT" })).toHaveAttribute("href", "https://github.com/Rynvex/tangent/blob/main/LICENSE");
    expect(screen.getByRole("link", { name: "GitHub repository" })).toHaveAttribute("href", "https://github.com/Rynvex/tangent");
    expect(screen.getByRole("link", { name: "Embedding guide" })).toHaveAttribute("target", "_blank");
  });
});
