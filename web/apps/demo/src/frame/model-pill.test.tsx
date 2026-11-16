// @vitest-environment jsdom
import type { CapabilityModels, TangentClient } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { TangentProvider, useLine } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyGuide } from "./empty-guide";
import { LineModelNote, ModelPill, useNewConversation } from "./model-pill";
import { createModelPrefsStore, EMPTY_MODEL_PREFS, withDefaultEffort, withDefaultModel, withFavorite, withHidden, type ModelPrefsStore } from "./model-prefs";

const CLAUDE = { provider: "claude-cli", model: "claude-opus-5-5" };

/** A G1 server's catalog: Claude CLI with efforts, a Codex CLI that is not installed, and the scenario's API models. */
const MODELS: CapabilityModels[] = [
  {
    provider: "claude-cli",
    models: ["claude-opus-5-5", "claude-haiku-5-5"],
    ready: true,
    details: [
      { model: "claude-opus-5-5", displayName: "Claude Opus 5.5", status: "current", effortLevels: ["low", "medium", "high", "max"] },
      { model: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", status: "current" },
    ],
  },
  { provider: "codex-cli", models: ["gpt-6.1-sol", "gpt-5.4-mini"], ready: false, reason: "binary not found", details: [{ model: "gpt-5.4-mini", displayName: "GPT-5.4 mini", status: "legacy" }] },
  { provider: "anthropic", models: ["claude-haiku-4-5", "claude-sonnet-4-5"] },
];

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
});

function setup(models: CapabilityModels[] | null = MODELS) {
  const scenario = nasScenario();
  const client = createMockTangentClient({ latencyMs: 0, scenario: { ...scenario, capabilities: { ...scenario.capabilities, ...(models ? { models } : { models: undefined }) } } });
  mocks.push(client);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client as TangentClient} locale="en">
        {children}
      </TangentProvider>
    </QueryClientProvider>
  );
  return { client, wrapper, store: createModelPrefsStore(() => null) };
}

/** The pill over the line as the cache holds it (as the conversation view passes it). */
function LivePill({ lineId, store, onError }: { lineId: string; store: ModelPrefsStore; onError?: (message: string) => void }) {
  const line = useLine(lineId);
  return line.data ? <ModelPill line={line.data} store={store} {...(onError ? { onError } : {})} /> : null;
}

const pill = () => screen.findByRole("button", { name: /^Model:/ });

describe("ModelPill (G1)", () => {
  it("shows the line's model and changes it at once", async () => {
    const { client, wrapper, store } = setup();
    render(<LivePill lineId={NAS_ROOT_ID} store={store} />, { wrapper });
    expect(await pill()).toHaveAccessibleName("Model: claude-sonnet-4-5");
    await userEvent.click(await pill());
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Claude Opus 5.5",
      "Claude Haiku 5.5",
      "gpt-6.1-solnot available",
      "GPT-5.4 mini (older)not available",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
    expect(screen.getByRole("menuitemradio", { name: "claude-sonnet-4-5" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("group", { name: "Reasoning effort" })).toBeNull();
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Claude Opus 5.5" }));
    await waitFor(async () => expect(await client.getLine(NAS_ROOT_ID)).toMatchObject(CLAUDE));
    await waitFor(async () => expect(await pill()).toHaveAccessibleName("Model: Claude Opus 5.5"));
  });

  it("offers the efforts the model takes and keeps the choice in the line", async () => {
    const { client, wrapper, store } = setup();
    await client.updateLine(NAS_ROOT_ID, CLAUDE);
    render(<LivePill lineId={NAS_ROOT_ID} store={store} />, { wrapper });
    await userEvent.click(await pill());
    const efforts = within(await screen.findByRole("group", { name: "Reasoning effort" })).getAllByRole("menuitemradio");
    expect(efforts.map((item) => item.textContent)).toEqual(["Model default", "Low", "Medium", "High", "Max"]);
    expect(efforts[0]).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    await waitFor(async () => expect((await client.getLine(NAS_ROOT_ID)).hostMeta).toEqual({ reasoningEffort: "high" }));
    await waitFor(async () => expect(await pill()).toHaveAccessibleName("Model: Claude Opus 5.5, reasoning effort High"));
    expect(await pill()).toHaveTextContent("Claude Opus 5.5· High");
  });

  it("does not show an effort the model does not take", async () => {
    const { client, wrapper, store } = setup();
    await client.updateLine(NAS_ROOT_ID, { provider: "claude-cli", model: "claude-haiku-5-5", reasoningEffort: "high" });
    render(<LivePill lineId={NAS_ROOT_ID} store={store} />, { wrapper });
    expect(await pill()).toHaveAccessibleName("Model: Claude Haiku 5.5");
  });

  it("makes the model and effort the default for new conversations", async () => {
    const { client, wrapper, store } = setup();
    await client.updateLine(NAS_ROOT_ID, { ...CLAUDE, reasoningEffort: "max" });
    render(<LivePill lineId={NAS_ROOT_ID} store={store} />, { wrapper });
    await userEvent.click(await pill());
    await userEvent.click(await screen.findByRole("menuitem", { name: "Use for new conversations" }));
    expect(store.get()).toStrictEqual({ favorites: [], hidden: [], defaultModel: CLAUDE, defaultEffort: "max" });
    await userEvent.click(await pill());
    expect(await screen.findByRole("menuitem", { name: "Default for new conversations" })).toHaveAttribute("aria-disabled", "true");
  });

  it("leaves hidden models out and lists favourites first", async () => {
    const { wrapper, store } = setup();
    store.set(withHidden(withFavorite(EMPTY_MODEL_PREFS, { provider: "anthropic", model: "claude-haiku-4-5" }, true), { provider: "codex-cli", model: "gpt-6.1-sol" }, true));
    render(<LivePill lineId={NAS_ROOT_ID} store={store} />, { wrapper });
    await userEvent.click(await pill());
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual(["claude-haiku-4-5", "Claude Opus 5.5", "Claude Haiku 5.5", "GPT-5.4 mini (older)not available", "claude-sonnet-4-5"]);
    expect(screen.getByText("Favourites")).toBeInTheDocument();
  });

  it("says why a change was refused", async () => {
    const { client, wrapper, store } = setup();
    const errors: string[] = [];
    client.updateLine = () => Promise.reject(new Error("offline"));
    render(<LivePill lineId={NAS_ROOT_ID} store={store} onError={(message) => errors.push(message)} />, { wrapper });
    await userEvent.click(await pill());
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Claude Opus 5.5" }));
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toMatch(/^Not changed: /);
  });

  it("is not shown when the server lists no models", async () => {
    const { wrapper, store } = setup(null);
    render(
      <>
        <LivePill lineId={NAS_ROOT_ID} store={store} />
        <span>ready</span>
      </>,
      { wrapper },
    );
    await screen.findByText("ready");
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(screen.queryByRole("button", { name: /^Model:/ })).toBeNull();
  });

  it("does not add a blank choice or allow making server default the default when the line has no model", async () => {
    const { client, wrapper, store } = setup();
    const blank = await client.createLine({});
    render(<LivePill lineId={blank.id} store={store} />, { wrapper });
    expect(await pill()).toHaveAccessibleName("Model: server default");
    await userEvent.click(await pill());
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((item) => item.textContent)).toEqual([
      "Claude Opus 5.5",
      "Claude Haiku 5.5",
      "gpt-6.1-solnot available",
      "GPT-5.4 mini (older)not available",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
    expect(screen.getByRole("menuitem", { name: "Use for new conversations" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("EmptyGuide with the model note (G1)", () => {
  function Note() {
    const line = useLine(NAS_ROOT_ID);
    return <EmptyGuide modelNote={line.data ? <LineModelNote line={line.data} /> : null} />;
  }

  it("says which model and effort an empty conversation uses", async () => {
    const { client, wrapper } = setup();
    await client.updateLine(NAS_ROOT_ID, { ...CLAUDE, reasoningEffort: "high" });
    render(<Note />, { wrapper });
    expect(await screen.findByTestId("line-model-note")).toHaveTextContent("This conversation uses Claude Opus 5.5 · reasoning effort High");
    expect(screen.getByRole("list", { name: "Getting started" })).toBeInTheDocument();
  });

  it("names the model alone without an effort, and nothing without a catalog", async () => {
    const first = setup();
    render(<Note />, { wrapper: first.wrapper });
    expect(await screen.findByTestId("line-model-note")).toHaveTextContent("This conversation uses claude-sonnet-4-5");
    cleanup();
    const second = setup(null);
    render(<Note />, { wrapper: second.wrapper });
    await screen.findByRole("list", { name: "Getting started" });
    expect(screen.queryByTestId("line-model-note")).toBeNull();
  });
});

describe("useNewConversation (新對話, G1)", () => {
  function NewButton({ store }: { store: ModelPrefsStore }) {
    const start = useNewConversation(store);
    const [created, setCreated] = useState<string | null>(null);
    return (
      <>
        <button type="button" onClick={() => void start.create().then((line) => setCreated(line.id))}>
          new
        </button>
        {created && <output>{created}</output>}
      </>
    );
  }

  async function createOne(store: ModelPrefsStore, models: CapabilityModels[] | null = MODELS) {
    const { client, wrapper } = setup(models);
    render(<NewButton store={store} />, { wrapper });
    // The default model is only asked for once the server's list is known.
    await waitFor(async () => expect(await client.getCapabilities()).toBeDefined());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    await userEvent.click(screen.getByRole("button", { name: "new" }));
    const id = (await screen.findByRole("status")).textContent ?? "";
    return client.getLine(id);
  }

  it("starts a conversation with the default model and effort", async () => {
    const store = createModelPrefsStore(() => null);
    store.set(withDefaultEffort(withDefaultModel(EMPTY_MODEL_PREFS, CLAUDE), "high"));
    const line = await createOne(store);
    expect(line).toMatchObject(CLAUDE);
    expect(line.hostMeta).toEqual({ reasoningEffort: "high" });
  });

  it("keeps the server's default when there is none, or the server no longer lists it", async () => {
    const plain = await createOne(createModelPrefsStore(() => null));
    expect(plain.model).toBe("");
    cleanup();
    const gone = createModelPrefsStore(() => null);
    gone.set(withDefaultModel(EMPTY_MODEL_PREFS, { provider: "claude-cli", model: "retired" }));
    expect((await createOne(gone)).provider).toBe("");
  });
});
