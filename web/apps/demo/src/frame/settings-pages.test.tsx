// @vitest-environment jsdom
import { normalizeLine, type Capabilities } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { arrangeModelChoices, EMPTY_MODEL_PREFS, modelPrefs, newLineInput } from "./model-prefs";
import { prefsStore } from "./prefs";
import { SettingsDialog, type SettingsDialogProps } from "./settings-dialog";

/** Settings → Providers, Threads and Archive (G2): the pages that read the server. */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  prefsStore.reset();
  modelPrefs.set(EMPTY_MODEL_PREFS);
  window.localStorage.clear();
});

/** G1's catalog: a ready CLI provider with details, one whose binary is missing, and an API provider that says nothing about readiness. */
const MODELS: NonNullable<Capabilities["models"]> = [
  {
    provider: "claude-cli",
    ready: true,
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    details: [
      { model: "claude-opus-5-5", displayName: "Claude Opus 5.5", status: "current", effortLevels: ["low", "medium", "high", "max"] },
      { model: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", status: "current", effortLevels: ["low", "medium", "high", "max"] },
      { model: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", status: "legacy" },
    ],
  },
  { provider: "codex-cli", ready: false, reason: "binary not found", models: ["gpt-6.1-sol"] },
  { provider: "fake", models: ["fake-1"] },
];

function setup(props: Partial<SettingsDialogProps> = {}, scenario = nasScenario()) {
  const client = createMockTangentClient({ latencyMs: 0, scenario });
  mocks.push(client);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        <ShortcutsProvider platform="other">{children}</ShortcutsProvider>
      </TangentProvider>
    </QueryClientProvider>
  );
  const line = normalizeLine({ id: "nas", title: "NAS", provider: "anthropic", model: "claude-sonnet-4-5" });
  const onOpenConversation = vi.fn();
  render(<SettingsDialog open onOpenChange={() => {}} embedded={false} line={line} onOpenConversation={onOpenConversation} initialCategory="threads" {...props} />, { wrapper });
  return { client, onOpenConversation };
}

const withModels = (models: Capabilities["models"] = MODELS) => {
  const scenario = nasScenario();
  return { ...scenario, capabilities: { ...scenario.capabilities, models } };
};
const dialogOf = () => screen.findByRole("dialog", { name: /^Settings/ });

describe("Settings → Providers (on G1's catalog)", () => {
  it("shows each provider's state, the reason and what to set up, and the ones this server does not have", async () => {
    setup({ initialCategory: "providers" }, withModels());
    const dialog = await dialogOf();
    const claude = await within(dialog).findByRole("region", { name: "claude-cli" });
    expect(within(claude).getByText("Ready")).toBeInTheDocument();
    expect(within(claude).getByText("3 model(s)")).toBeInTheDocument();
    expect(within(claude).queryByText(/Install Claude Code/)).toBeNull();
    const codex = within(dialog).getByRole("region", { name: "codex-cli" });
    expect(within(codex).getByText("Not ready")).toBeInTheDocument();
    expect(within(codex).getByText("Reason: binary not found")).toBeInTheDocument();
    expect(within(codex).getByText(/TANGENT_CODEX_CLI_PATH/)).toBeInTheDocument();
    // An API provider says nothing about readiness; one the server does not list is not enabled, with its setup.
    expect(within(within(dialog).getByRole("region", { name: "fake" })).getByText("Enabled")).toBeInTheDocument();
    const anthropic = within(dialog).getByRole("region", { name: "anthropic" });
    expect(within(anthropic).getByText("Not enabled on this server")).toBeInTheDocument();
    expect(within(anthropic).getByText(/ANTHROPIC_API_KEY/)).toBeInTheDocument();
    expect([...dialog.querySelectorAll("[data-provider]")].map((card) => card.getAttribute("data-provider"))).toEqual(["claude-cli", "codex-cli", "agy-cli", "openai", "anthropic", "fake"]);
    // Display names and the older mark come from the catalog.
    expect(within(claude).getByText("Claude Haiku 5.5")).toBeInTheDocument();
    expect(within(claude).getByText("Older")).toBeInTheDocument();
  });

  it("favourites and hides models: the pickers leave hidden ones out and put favourites first", async () => {
    const user = userEvent.setup();
    setup({ initialCategory: "providers" }, withModels());
    const dialog = await dialogOf();
    const claude = await within(dialog).findByRole("region", { name: "claude-cli" });
    const favourite = within(claude).getByRole("button", { name: "Favourite Claude Sonnet 5.5" });
    expect(favourite).toHaveAttribute("aria-pressed", "false");
    await user.click(favourite);
    expect(within(claude).getByRole("button", { name: "Remove Claude Sonnet 5.5 from favourites" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(claude).getByRole("button", { name: "Hide Claude Haiku 5.5" }));
    expect(within(claude).getByRole("button", { name: "Show Claude Haiku 5.5" })).toHaveAttribute("aria-pressed", "true");
    expect(within(claude).getByText("Hidden")).toBeInTheDocument();
    expect(modelPrefs.get()).toEqual({ favorites: [{ provider: "claude-cli", model: "claude-sonnet-5-5" }], hidden: [{ provider: "claude-cli", model: "claude-haiku-5-5" }] });
    // Kept in this browser (model-prefs.ts's key), and what every picker arranges its choices by.
    expect(JSON.parse(window.localStorage.getItem("tangent:model-prefs")!)).toMatchObject({ version: 1, hidden: [{ provider: "claude-cli", model: "claude-haiku-5-5" }] });
    const choices = MODELS.flatMap((group) => group.models.map((model) => ({ provider: group.provider, model })));
    expect(arrangeModelChoices(choices, modelPrefs.get()).map((choice) => choice.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "gpt-6.1-sol", "fake-1"]);

    // The Threads page's default-model list is one of those pickers.
    await user.click(within(dialog).getByRole("button", { name: "Threads" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Default model for new conversations" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Server default", "claude-cli · Claude Sonnet 5.5", "claude-cli · Claude Opus 5.5", "codex-cli · gpt-6.1-sol", "fake · fake-1"]);

    // Shown again, it comes back.
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "Providers" }));
    await user.click(within(await within(dialog).findByRole("region", { name: "claude-cli" })).getByRole("button", { name: "Show Claude Haiku 5.5" }));
    expect(modelPrefs.get().hidden).toEqual([]);
  });

  it("says so when the server lists no models", async () => {
    const scenario = nasScenario();
    const { models: _unlisted, ...capabilities } = scenario.capabilities;
    setup({ initialCategory: "providers" }, { ...scenario, capabilities });
    const dialog = await dialogOf();
    expect(await within(dialog).findByText(/does not list its models/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "claude-cli" })).toBeNull();
  });
});

describe("Settings → Threads: what a new conversation starts with", () => {
  it("sets the default model and a reasoning effort that model takes; new conversations get both", async () => {
    const user = userEvent.setup();
    const scenario = withModels();
    setup({}, scenario);
    const dialog = await dialogOf();
    const model = await within(dialog).findByRole("combobox", { name: "Default model for new conversations" });
    await waitFor(() => expect(model).toHaveTextContent("Server default"));
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "claude-cli · Claude Opus 5.5" }));
    expect(modelPrefs.get().defaultModel).toEqual({ provider: "claude-cli", model: "claude-opus-5-5" });

    await user.click(within(dialog).getByRole("combobox", { name: "Default reasoning effort" }));
    // Only what Opus takes (no "Extra high": that is Codex's).
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Model default", "Low", "Medium", "High", "Max"]);
    await user.click(screen.getByRole("option", { name: "High" }));
    expect(modelPrefs.get().defaultEffort).toBe("high");
    expect(newLineInput(modelPrefs.get(), scenario.capabilities)).toEqual({ provider: "claude-cli", model: "claude-opus-5-5", reasoningEffort: "high" });

    // Back to the server's own.
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "Server default" }));
    expect(modelPrefs.get().defaultModel).toBeUndefined();
  });

  it("has no effort to offer for a model that takes none", async () => {
    const user = userEvent.setup();
    setup({}, withModels());
    const dialog = await dialogOf();
    const model = await within(dialog).findByRole("combobox", { name: "Default model for new conversations" });
    await waitFor(() => expect(model).toHaveTextContent("Server default"));
    await user.click(model);
    await user.click(await screen.findByRole("option", { name: "fake · fake-1" }));
    expect(within(dialog).getByRole("combobox", { name: "Default reasoning effort" })).toHaveAttribute("data-disabled");
  });
});

describe("Settings → Threads: this conversation and the feature list (A13, F9 B.4)", () => {
  it("lists the features from /capabilities, read-only: the host decides every mode", async () => {
    setup();
    const dialog = await dialogOf();
    expect(within(dialog).getByText("Branches and conclusion cards")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("Branch suggestions")).toBeInTheDocument());
    expect(within(dialog).getAllByText(/Set by the host: Suggest/).length).toBeGreaterThan(0);
    expect(within(dialog).queryByRole("radiogroup", { name: "Branch suggestions" })).toBeNull();
    // G2: against a server, the page says which setting decides the features.
    expect(within(dialog).getByText(/reads its features from TANGENT_FEATURES/)).toBeInTheDocument();
  });

  it("says the other features are off when only the core is on", async () => {
    setup({}, nasScenario({ features: "core" }));
    const dialog = await dialogOf();
    await waitFor(() => expect(within(dialog).getByText("The host turned the other features off.")).toBeInTheDocument());
  });

  it("shows this conversation's provider and model; without a server list they cannot change", async () => {
    const scenario = nasScenario();
    const { models: _unlisted, ...capabilities } = scenario.capabilities;
    setup({}, { ...scenario, capabilities });
    const dialog = await dialogOf();
    expect(within(dialog).getByRole("heading", { name: "This conversation" })).toBeInTheDocument();
    expect(within(dialog).getByText("anthropic · claude-sonnet-4-5")).toBeInTheDocument();
    expect(within(dialog).getByText(/does not list other models/)).toBeInTheDocument();
  });

  it("offers the server's models and changes the line's model", async () => {
    const { client } = setup({}, withModels([{ provider: "anthropic", models: ["claude-sonnet-4-5", "claude-haiku-4-5"] }]));
    const spy = vi.spyOn(client, "updateLine");
    const dialog = await dialogOf();
    const select = await within(dialog).findByRole("combobox", { name: "Model" });
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole("option", { name: "anthropic · claude-haiku-4-5" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("nas", { provider: "anthropic", model: "claude-haiku-4-5" }));
  });

  it("files the features under four headings, the core first", async () => {
    setup();
    const dialog = await dialogOf();
    await waitFor(() => expect(within(dialog).getByRole("group", { name: "Background AI and memory" })).toBeInTheDocument());
    const navigation = within(dialog).getByRole("group", { name: "Branches and navigation" });
    expect(within(navigation).getByText("Branches and conclusion cards")).toBeInTheDocument();
    expect(within(navigation).getByText("Quick asides")).toBeInTheDocument();
    expect(within(within(dialog).getByRole("group", { name: "Deep discussion and converging options" })).getByText("Branch suggestions")).toBeInTheDocument();
    expect(within(within(dialog).getByRole("group", { name: "Learning records and key points" })).getByText("Notes")).toBeInTheDocument();
    expect(within(within(dialog).getByRole("group", { name: "Background AI and memory" })).getByText("Memory")).toBeInTheDocument();
  });

  it("against a server, a preset shows the TANGENT_FEATURES line to restart with and copies it; nothing is sent", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    // The page's only write is the line's model; a preset makes no request at all.
    const write = vi.spyOn(client, "updateLine");
    const dialog = await dialogOf();
    const presets = within(dialog).getByRole("group", { name: "Quick presets" });
    expect(within(presets).getAllByRole("button").map((button) => button.textContent)).toEqual(["Standard", "Deep research and decisions", "Light learning notes"]);
    await user.click(within(presets).getByRole("button", { name: "Light learning notes" }));
    expect(within(presets).getByRole("button", { name: "Light learning notes" })).toHaveAttribute("aria-pressed", "true");
    const line = "TANGENT_FEATURES=notes,chapters,aside,summary:auto,card_draft,search,leaf:suggest,memo,glossary,fold:suggest";
    expect(within(dialog).getByText(line)).toBeInTheDocument();
    expect(within(dialog).getByText(/restart it with this line/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(line);
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it("says when the server already runs the preset", async () => {
    const user = userEvent.setup();
    setup({}, nasScenario({ features: "research" }));
    const dialog = await dialogOf();
    await waitFor(() => expect(within(dialog).getByText("Argument types")).toBeInTheDocument());
    await user.click(within(dialog).getByRole("button", { name: "Deep research and decisions" }));
    expect(within(dialog).getByText("The server runs this preset.")).toHaveAttribute("role", "status");
    await user.click(within(dialog).getByRole("button", { name: "Standard" }));
    expect(within(dialog).queryByText("The server runs this preset.")).toBeNull();
  });

  it("on the mock, a preset switches the mock's features, and the one in use is pressed and chosen", async () => {
    const onChange = vi.fn();
    setup({ featureSet: { value: "learning", onChange } });
    const dialog = await dialogOf();
    const presets = within(dialog).getByRole("group", { name: "Quick presets" });
    expect(within(presets).getByRole("button", { name: "Light learning notes" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("radio", { name: "Light learning notes" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByText(/TANGENT_FEATURES=/)).toBeNull();
    expect(within(dialog).getByText(/in-browser mock/)).toBeInTheDocument();
    await userEvent.click(within(presets).getByRole("button", { name: "Standard" }));
    expect(onChange).toHaveBeenLastCalledWith("standard");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Core only" }));
    expect(onChange).toHaveBeenLastCalledWith("core");
  });
});

describe("Settings → Archive", () => {
  it("lists the archived conversations, searches them and opens one", async () => {
    const user = userEvent.setup();
    const { onOpenConversation } = setup({ initialCategory: "archive" });
    const dialog = await dialogOf();
    expect(await within(dialog).findByRole("button", { name: "Proxmox 叢集規劃" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "咖啡豆的保存方式" })).toBeInTheDocument();
    await user.type(within(dialog).getByRole("searchbox", { name: "Search archived conversations" }), "proxmox");
    expect(within(dialog).queryByRole("button", { name: "咖啡豆的保存方式" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Proxmox 叢集規劃" }));
    expect(onOpenConversation).toHaveBeenCalledWith("arch-1");
    await user.clear(within(dialog).getByRole("searchbox", { name: "Search archived conversations" }));
    await user.type(within(dialog).getByRole("searchbox", { name: "Search archived conversations" }), "zzz");
    expect(within(dialog).getByText("No archived conversation matches “zzz”.")).toBeInTheDocument();
  });

  it("restores a conversation to the list in one press", async () => {
    const user = userEvent.setup();
    const { client } = setup({ initialCategory: "archive" });
    const dialog = await dialogOf();
    await user.click(await within(dialog).findByRole("button", { name: "Restore “咖啡豆的保存方式”" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "咖啡豆的保存方式" })).toBeNull());
    expect(within(dialog).getByText("“咖啡豆的保存方式” is back in the list.")).toBeInTheDocument();
    expect((await client.listLines({})).lines.map((line) => line.id)).toContain("arch-2");
    expect((await client.listLines({ archived: true })).lines.map((line) => line.id)).toEqual(["arch-1"]);
  });

  it("deletes forever only after the second answer", async () => {
    const user = userEvent.setup();
    const { client } = setup({ initialCategory: "archive" });
    const remove = vi.spyOn(client, "deleteLine");
    const dialog = await dialogOf();
    await user.click(await within(dialog).findByRole("button", { name: "Delete “咖啡豆的保存方式” forever" }));
    const question = within(dialog).getByRole("group", { name: "Delete “咖啡豆的保存方式” forever" });
    expect(within(question).getByText(/cannot be undone/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(question).getByRole("button", { name: "Keep" }));
    expect(within(dialog).getByRole("button", { name: "咖啡豆的保存方式" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete “咖啡豆的保存方式” forever" }));
    await user.click(within(within(dialog).getByRole("group", { name: "Delete “咖啡豆的保存方式” forever" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "咖啡豆的保存方式" })).toBeNull());
    expect(remove).toHaveBeenCalledWith("arch-2");
    expect(within(dialog).getByText("“咖啡豆的保存方式” was deleted.")).toBeInTheDocument();
    expect((await client.listLines({ archived: true })).lines.map((line) => line.id)).toEqual(["arch-1"]);
  });

  it("only lists for a read-only identity", async () => {
    const scenario = nasScenario();
    setup({ initialCategory: "archive" }, { ...scenario, capabilities: { ...scenario.capabilities, permissions: { canWrite: false } } });
    const dialog = await dialogOf();
    expect(await within(dialog).findByRole("button", { name: "Proxmox 叢集規劃" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Restore “/ })).toBeNull();
    expect(within(dialog).getByText(/can only read/)).toBeInTheDocument();
  });
});
