// @vitest-environment jsdom
import { normalizeLine, TangentError, type TangentClient, type TangentEvent } from "@tangent/client";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { Composer, loadMarkdownRenderer, Markdown, ShortcutsProvider, TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationList } from "./conversation-list";
import { ConversationMenu } from "./conversation-menu";
import { ConversationView } from "./conversation-view";
import { useConversationDeletion, type ConversationDeletionOptions } from "./delete-host";
import { timeLabel } from "./list-model";
import { createPinnedStore, PINNED_ROOTS_KEY, type PinnedStorage } from "./pinned-roots";
import { costThresholdFor, prefsStore, usePrefs, type DemoPrefs } from "./prefs";
import { PrefsProviders } from "./prefs-apply";
import { useReplyToast, type ReplyToastOptions } from "./reply-toast";

/**
 * G2: every setting takes effect. Each test changes the preferences the way
 * the Settings page does (the store) and looks at the part of the app that
 * is supposed to follow.
 */

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  await loadMarkdownRenderer();
});

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  prefsStore.reset();
  window.localStorage.clear();
});

function mock(options: Parameters<typeof createMockTangentClient>[0] = {}) {
  const client = createMockTangentClient({ latencyMs: 0, scenario: nasScenario(), ...options });
  mocks.push(client);
  return client;
}

/** As in the app (shell.tsx): the providers follow the page's preferences. */
function Wired({ children }: { children: ReactNode }) {
  return <PrefsProviders prefs={usePrefs()}>{children}</PrefsProviders>;
}

function providers(client: TangentClient, locale = "en", extra: { costThreshold?: number } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale={locale} {...extra}>
        <Wired>{children}</Wired>
      </TangentProvider>
    </QueryClientProvider>
  );
}

const set = (patch: Partial<DemoPrefs>) => act(() => prefsStore.update(patch));

describe("Appearance → code blocks and math reach the Markdown renderer", () => {
  const TEXT = "```sh\nrsync -avh --delete /mnt/tank/photos/ backup@nas.example:/volume1/photos/\n```\n\nIt is $x^2$ here.";

  it("word wrap and the code size apply to code blocks on screen, and go back", () => {
    const { container } = render(<Markdown>{TEXT}</Markdown>, { wrapper: providers(mock()) });
    const pre = container.querySelector("pre")!;
    expect(pre).toHaveClass("overflow-x-auto", "text-tg-sm");
    expect(pre).not.toHaveClass("whitespace-pre-wrap");
    set({ codeWrap: true, codeFontSize: "lg" });
    expect(pre).toHaveClass("whitespace-pre-wrap", "text-tg-md");
    set({ codeWrap: false, codeFontSize: "sm" });
    expect(pre).not.toHaveClass("whitespace-pre-wrap");
    expect(pre).toHaveClass("text-tg-xs");
  });

  it("render math off leaves $…$ as written; on renders it with KaTeX", async () => {
    prefsStore.update({ renderMath: false });
    const { container } = render(<Markdown>{TEXT}</Markdown>, { wrapper: providers(mock()) });
    await act(async () => {});
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("It is $x^2$ here.");
    set({ renderMath: true });
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
  });

  it("the cost threshold `off` never shows a turn's cost", () => {
    const estimate = { tokens: 9_000_000, costUsd: 42 };
    const box = <Composer value="x" onValueChange={() => {}} onSend={() => {}} estimate={estimate} />;
    const { unmount } = render(box, { wrapper: providers(mock(), "en", { costThreshold: costThresholdFor({ costThreshold: 0.1 }) }) });
    expect(screen.getByText(/This turn ≈ US\$42/)).toBeInTheDocument();
    unmount();
    render(box, { wrapper: providers(mock(), "en", { costThreshold: costThresholdFor({ costThreshold: "off" }) }) });
    expect(screen.queryByText(/This turn ≈/)).toBeNull();
  });
});

function Conversation({ lineId }: { lineId: string }) {
  const [draft, setDraft] = useState("");
  return <ConversationView lineId={lineId} draft={draft} onDraftChange={setDraft} forcedBanner={null} focus={null} onFlow={() => {}} navigate={() => {}} onPreview={() => {}} toast={() => {}} />;
}

describe("Appearance → chat width and Chat → follow-up reach the conversation", () => {
  it("the messages and the message box take the chosen width", async () => {
    render(<Conversation lineId={NAS_ROOT_ID} />, { wrapper: providers(mock()) });
    const box = await screen.findByRole("textbox", { name: "Message" }, { timeout: 3000 });
    const column = document.querySelector<HTMLElement>("[data-tg-chat-width]")!;
    const composer = box.closest(".mx-auto")!;
    expect(column).toHaveAttribute("data-tg-chat-width", "reading");
    expect(column).toHaveClass("max-w-tg-reading");
    expect(composer).toHaveClass("max-w-tg-reading");
    set({ chatWidth: "wide" });
    expect(column).toHaveAttribute("data-tg-chat-width", "wide");
    expect(column).toHaveClass("max-w-5xl");
    expect(column).not.toHaveClass("max-w-tg-reading");
    expect(composer).toHaveClass("max-w-5xl");
    set({ chatWidth: "full" });
    expect(column).toHaveClass("max-w-none");
    expect(composer).toHaveClass("max-w-none");
  });

  it("a draft sent while a reply streams waits by default, and stops the reply first with stop-and-send", async () => {
    const user = userEvent.setup();
    // Slow chunks: the first reply is still arriving when the follow-up is written.
    const client = mock({ chunkMs: 400 });
    const send = vi.spyOn(client, "sendMessage");
    const cancel = vi.spyOn(client, "cancelTurn");
    render(<Conversation lineId={NAS_ROOT_ID} />, { wrapper: providers(client) });
    const box = await screen.findByRole("textbox", { name: "Message" }, { timeout: 3000 });
    await user.type(box, "first{Enter}");
    await screen.findByRole("button", { name: "Stop the reply" });
    await user.type(box, "second");
    // Wait (the default): the button is still the stop, Enter does not send.
    expect(screen.getByRole("button", { name: "Stop the reply" })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(send).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();

    set({ followUp: "stop_and_send" });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[1]!);
    expect(send.mock.calls[1]).toEqual([NAS_ROOT_ID, { content: "second" }]);
    expect(box).toHaveValue("");
  });
});

function memoryPins(initial: string[] = []): PinnedStorage {
  const data: Record<string, string> = { [PINNED_ROOTS_KEY]: JSON.stringify(initial) };
  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

describe("General → confirmations reach the conversation menu", () => {
  const NAS = normalizeLine({ id: NAS_ROOT_ID, title: "家用 NAS" });
  const open = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Actions for “家用 NAS”" }));

  function setup(pinned: string[] = []) {
    const client = mock();
    const store = createPinnedStore(() => memoryPins(pinned));
    const archive = vi.spyOn(client, "archiveLine");
    render(<ConversationMenu line={NAS} onDelete={() => {}} pinned={store} />, { wrapper: providers(client) });
    return { store, archive };
  }

  it("archives at once by default", async () => {
    const user = userEvent.setup();
    const { archive } = setup();
    await open(user);
    await user.click(await screen.findByRole("menuitem", { name: "Archive conversation" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith(NAS_ROOT_ID));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with the archive confirmation on, asks first: Cancel keeps it, Archive archives", async () => {
    const user = userEvent.setup();
    prefsStore.update({ confirmArchive: true });
    const { archive } = setup();
    await open(user);
    await user.click(await screen.findByRole("menuitem", { name: "Archive conversation" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive “家用 NAS”?" });
    expect(archive).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(archive).not.toHaveBeenCalled();
    await open(user);
    await user.click(await screen.findByRole("menuitem", { name: "Archive conversation" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Archive “家用 NAS”?" })).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith(NAS_ROOT_ID));
  });

  it("unpins at once by default, and asks first with the unpin confirmation on; pinning never asks", async () => {
    const user = userEvent.setup();
    const { store } = setup([NAS_ROOT_ID]);
    await open(user);
    await user.click(await screen.findByRole("menuitem", { name: /Unpin/ }));
    expect(store.get()).toEqual([]);

    set({ confirmUnpin: true });
    await open(user);
    await user.click(await screen.findByRole("menuitem", { name: /Pin to top/ }));
    expect(store.get()).toEqual([NAS_ROOT_ID]);
    expect(screen.queryByRole("dialog")).toBeNull();
    await open(user);
    await user.click(await screen.findByRole("menuitem", { name: /Unpin/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unpin “家用 NAS”?" });
    expect(store.get()).toEqual([NAS_ROOT_ID]);
    await user.click(within(dialog).getByRole("button", { name: "Unpin" }));
    expect(store.get()).toEqual([]);
  });

  it("Chat → quick aside default `keep` takes the per-conversation choice out of the menu", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    expect(await screen.findByRole("menuitemradio", { name: /Kept/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    set({ asideDefault: "keep" });
    await open(user);
    await screen.findByRole("menuitem", { name: "Archive conversation" });
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });
});

describe("General → delete confirmation reaches the frame's delete", () => {
  const NAS = normalizeLine({ id: NAS_ROOT_ID, title: "家用 NAS" });

  function setup(confirm: boolean, client = mock()) {
    const leave = vi.fn();
    const toast = vi.fn();
    const remove = vi.spyOn(client, "deleteLine");
    const hook = renderHook((options: ConversationDeletionOptions) => useConversationDeletion(options), {
      wrapper: providers(client),
      initialProps: { selected: NAS_ROOT_ID, rootId: NAS_ROOT_ID, lineError: null, leave, toast, confirm },
    });
    return { hook, leave, toast, remove };
  }

  it("on: 刪除對話… only opens the confirmation", () => {
    const { hook, remove } = setup(true);
    act(() => hook.result.current.request(NAS));
    expect(hook.result.current.dialog).toMatchObject({ open: true, line: { id: NAS_ROOT_ID } });
    expect(remove).not.toHaveBeenCalled();
  });

  it("off: it deletes at once, leaves the conversation and names it, with no dialog", async () => {
    const { hook, leave, toast, remove } = setup(false);
    act(() => hook.result.current.request(NAS));
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith(NAS_ROOT_ID);
    expect([...leave.mock.calls[0]![0]]).toContain(NAS_ROOT_ID);
    expect(toast).toHaveBeenCalledWith("Deleted “家用 NAS”.");
    expect(hook.result.current.dialog).toBeNull();
  });

  it("off, and the server refuses: says why and falls back to the confirmation", async () => {
    const client = mock();
    vi.spyOn(client, "deleteLine").mockRejectedValue(new TangentError(409, "a turn is running", "session_busy"));
    const { hook, leave, toast } = setup(false, client);
    act(() => hook.result.current.request(NAS));
    await waitFor(() => expect(hook.result.current.dialog).toMatchObject({ open: true, line: { id: NAS_ROOT_ID } }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
  });
});

describe("General → sidebar and formatting reach the conversation list", () => {
  it("activity badges can be hidden; the rows and their tags stay", async () => {
    render(<ConversationList current={null} onSelect={() => {}} onNew={() => {}} onDelete={() => {}} />, { wrapper: providers(mock()) });
    await screen.findByText("家用 NAS 與備份策略");
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    await waitFor(() => expect(within(nav).getAllByText(/\d+ open/).length).toBeGreaterThan(0));
    const tags = within(nav).queryAllByText(/^#/).length;
    set({ activityBadges: false });
    expect(within(nav).queryByText(/\d+ open/)).toBeNull();
    expect(within(nav).queryByText(/\d+ unread/)).toBeNull();
    expect(within(nav).queryByText(/waiting for you/)).toBeNull();
    expect(within(nav).getByText("家用 NAS 與備份策略")).toBeInTheDocument();
    expect(within(nav).queryAllByText(/^#/)).toHaveLength(tags);
    set({ activityBadges: true });
    expect(within(nav).getAllByText(/\d+ open/).length).toBeGreaterThan(0);
  });

  it("today's rows read the clock in the chosen format", () => {
    const at = new Date(2026, 9, 5, 20, 42).toISOString();
    expect(timeLabel(at, new Date(2026, 9, 5, 21, 0), "en")).toBe("20:42");
    expect(timeLabel(at, new Date(2026, 9, 5, 21, 0), "en", undefined, true)).toBe("8:42 PM");
    // Other days show the weekday or the date either way.
    expect(timeLabel(at, new Date(2026, 9, 7, 9, 0), "en", undefined, true)).toBe(timeLabel(at, new Date(2026, 9, 7, 9, 0), "en"));
  });

  it("the list follows the time format setting", async () => {
    const scenario = nasScenario();
    const today = new Date();
    today.setHours(14, 52, 0, 0);
    const lines = scenario.lines.map((line) => (line.id === NAS_ROOT_ID ? { ...line, lastActivityAt: today.toISOString() } : line));
    render(<ConversationList current={null} onSelect={() => {}} onNew={() => {}} onDelete={() => {}} now={new Date(today.getTime() + 60_000)} />, { wrapper: providers(mock({ scenario: { ...scenario, lines } })) });
    const row = (await screen.findByText("家用 NAS 與備份策略")).closest("button")!;
    expect(row).toHaveTextContent("14:52");
    set({ timeFormat: "12h" });
    expect(row).toHaveTextContent("2:52 PM");
    set({ timeFormat: "24h" });
    expect(row).toHaveTextContent("14:52");
  });
});

describe("General → in-app notifications reach the background-reply toast", () => {
  const reply = (status: string): TangentEvent =>
    ({ type: "message.updated", tenant: "", lineId: "nas-b2", rootLineId: "nas", data: { id: "m9", lineId: "nas-b2", role: "assistant", kind: "chat", status, content: "", meta: {} } }) as unknown as TangentEvent;
  const options = (enabled: boolean): ReplyToastOptions => ({ rootId: "nas", selected: "nas", focusOn: false, inline: new Set(), describe: () => ({ title: "UPS", aside: false }), enabled });

  it("on: a reply finishing on another line raises the toast", () => {
    const hook = renderHook((props: ReplyToastOptions) => useReplyToast(props), { initialProps: options(true) });
    act(() => hook.result.current.onEvent(reply("pending")));
    act(() => hook.result.current.onEvent(reply("done")));
    expect(hook.result.current.toast).toMatchObject({ lineId: "nas-b2", title: "UPS" });
    // Turned off while it shows: it goes at once.
    hook.rerender(options(false));
    expect(hook.result.current.toast).toBeNull();
  });

  it("off: the same reply raises nothing", () => {
    const hook = renderHook((props: ReplyToastOptions) => useReplyToast(props), { initialProps: options(false) });
    act(() => hook.result.current.onEvent(reply("pending")));
    act(() => hook.result.current.onEvent(reply("done")));
    expect(hook.result.current.toast).toBeNull();
    hook.rerender(options(true));
    expect(hook.result.current.toast).toBeNull();
  });
});

describe("the providers need no ShortcutsProvider of their own", () => {
  it("PrefsProviders is the frame's ShortcutsProvider (a second one inside still works for embeds)", () => {
    render(
      <ShortcutsProvider>
        <Markdown>plain</Markdown>
      </ShortcutsProvider>,
      { wrapper: providers(mock()) },
    );
    expect(screen.getByText("plain")).toBeInTheDocument();
  });
});
