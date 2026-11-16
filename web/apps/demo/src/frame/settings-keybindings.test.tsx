// @vitest-environment jsdom
import { createMockTangentClient } from "@tangent/client/testing";
import { Composer, Dialog, DialogContent, TangentProvider, useCommand } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrefsStore, PREFS_KEY, prefsStore, usePrefs } from "./prefs";
import { PrefsProviders, useComposerHint } from "./prefs-apply";
import { KeybindingsPanel } from "./settings-keybindings";

/** Settings → Keybindings (G2): recording, conflicts, persistence, and the keys taking effect. */

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  prefsStore.reset();
  window.localStorage.clear();
});

function Commands({ onBranch, onNew }: { onBranch: () => void; onNew: () => void }) {
  useCommand("branch.open", onBranch);
  useCommand("conversation.new", onNew);
  return null;
}

function MessageBox({ onSend }: { onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("hello");
  const hint = useComposerHint();
  return <Composer value={draft} onValueChange={setDraft} onSend={onSend} {...(hint ? { hint } : {})} />;
}

/** As in the app: the providers read the page's preferences, so a recorded key is live at once. */
function Wired({ children }: { children: ReactNode }) {
  return <PrefsProviders prefs={usePrefs()}>{children}</PrefsProviders>;
}

function setup({ inDialog = false }: { inDialog?: boolean } = {}) {
  const client = createMockTangentClient({ latencyMs: 0 });
  mocks.push(client);
  const onBranch = vi.fn();
  const onNew = vi.fn();
  const onSend = vi.fn();
  const onOpenChange = vi.fn();
  const panel = <KeybindingsPanel />;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TangentProvider client={client} locale="en">
        <Wired>
          <Commands onBranch={onBranch} onNew={onNew} />
          <MessageBox onSend={onSend} />
          {inDialog ? (
            <Dialog open onOpenChange={onOpenChange}>
              <DialogContent title="Settings">{panel}</DialogContent>
            </Dialog>
          ) : (
            panel
          )}
        </Wired>
      </TangentProvider>
    </QueryClientProvider>,
  );
  return { onBranch, onNew, onSend, onOpenChange };
}

const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-command="${id}"]`)!;
const recorder = (command: string) => screen.getByRole("button", { name: new RegExp(`^Change the keys of “${command}”`) });
const keysOf = (id: string) => [...within(rowOf(id)).getByRole("button", { name: /^Change the keys/ }).querySelectorAll("kbd")].map((key) => key.textContent);

describe("Settings → Keybindings", () => {
  it("lists every command with its default keys and the keys it has now, in the shortcut list's groups", () => {
    setup();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Navigation", "Branches", "Notes and parking", "Focus mode"]);
    expect(keysOf("branch.open")).toEqual(["Ctrl", "B"]);
    expect([...rowOf("branch.open").querySelectorAll("kbd")].map((key) => key.textContent)).toEqual(["Ctrl", "B", "Ctrl", "B"]);
    // A palette-only command has no keys yet, and can be given some.
    expect(within(rowOf("conversation.new")).getAllByText("None")).toHaveLength(2);
    expect(within(rowOf("branch.open")).getByRole("button", { name: "Reset the keys of “Open a branch”" })).toBeDisabled();
  });

  it("filters the commands by name or keys", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByRole("searchbox", { name: "Filter commands" }), "branch");
    expect([...document.querySelectorAll("[data-command]")].map((row) => row.getAttribute("data-command"))).toEqual(["nav.toBranch", "branch.open", "branch.bringBack"]);
    await user.clear(screen.getByRole("searchbox", { name: "Filter commands" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter commands" }), "ctrl+shift+f");
    expect([...document.querySelectorAll("[data-command]")].map((row) => row.getAttribute("data-command"))).toEqual(["focus.toggle"]);
    await user.clear(screen.getByRole("searchbox", { name: "Filter commands" }));
    await user.type(screen.getByRole("searchbox", { name: "Filter commands" }), "zzz");
    expect(screen.getByText("No command matches “zzz”.")).toBeInTheDocument();
  });

  it("records new keys: they replace the old ones at once, are kept in this browser and survive a reload", async () => {
    const user = userEvent.setup();
    const { onBranch } = setup();
    await user.click(recorder("Open a branch"));
    expect(recorder("Open a branch")).toHaveAttribute("aria-pressed", "true");
    expect(recorder("Open a branch")).toHaveTextContent("Press the new keys… Esc cancels");
    // Modifiers alone do not end the recording.
    fireEvent.keyDown(recorder("Open a branch"), { key: "Control", ctrlKey: true });
    expect(recorder("Open a branch")).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(recorder("Open a branch"), { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    // Recording a key never runs a command.
    expect(onBranch).not.toHaveBeenCalled();
    expect(keysOf("branch.open")).toEqual(["Ctrl", "Shift", "L"]);
    expect(screen.getByText("“Open a branch” is now Ctrl+Shift+L.")).toBeInTheDocument();
    expect(within(rowOf("branch.open")).getByText("Changed")).toBeInTheDocument();
    expect(prefsStore.get().keybindings).toEqual({ "branch.open": "Mod+Shift+L" });

    // The new keys work; the old ones no longer do.
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    expect(onBranch).toHaveBeenCalledTimes(1);

    // What a reload reads.
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!)).toMatchObject({ version: 2, keybindings: { "branch.open": "Mod+Shift+L" } });
    expect(createPrefsStore(() => window.localStorage).get().keybindings).toEqual({ "branch.open": "Mod+Shift+L" });
  });

  it("gives keys to a command that had none", async () => {
    const user = userEvent.setup();
    const { onNew } = setup();
    await user.click(recorder("New conversation"));
    fireEvent.keyDown(recorder("New conversation"), { key: "n", code: "KeyN", altKey: true });
    expect(keysOf("conversation.new")).toEqual(["Alt", "N"]);
    fireEvent.keyDown(document.body, { key: "n", code: "KeyN", altKey: true });
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("refuses keys another command has, names it, and changes nothing", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(recorder("Open a branch"));
    fireEvent.keyDown(recorder("Open a branch"), { key: "k", code: "KeyK", ctrlKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Ctrl+K already belongs to “Command palette”. Change that one first, or pick other keys.");
    expect(keysOf("branch.open")).toEqual(["Ctrl", "B"]);
    expect(prefsStore.get().keybindings).toEqual({});
    expect(recorder("Open a branch")).toHaveAttribute("aria-pressed", "false");
  });

  it("refuses a key that would swallow typing", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(recorder("Open a branch"));
    fireEvent.keyDown(recorder("Open a branch"), { key: "a", code: "KeyA" });
    expect(screen.getByRole("alert")).toHaveTextContent("That key cannot be used on its own.");
    expect(prefsStore.get().keybindings).toEqual({});
  });

  it("Esc cancels a recording and leaves the dialog open; leaving the button cancels too", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup({ inDialog: true });
    await user.click(recorder("Open a branch"));
    await user.keyboard("{Escape}");
    expect(recorder("Open a branch")).toHaveAttribute("aria-pressed", "false");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(prefsStore.get().keybindings).toEqual({});
    await user.click(recorder("Open a branch"));
    await user.tab();
    expect(recorder("Open a branch")).toHaveAttribute("aria-pressed", "false");
    // Not recording, Esc is the dialog's again.
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  it("resets one command to its default, and all of them", async () => {
    const user = userEvent.setup();
    prefsStore.update({ keybindings: { "branch.open": "Mod+Shift+L", "notes.add": "Alt+N" } });
    const { onBranch } = setup();
    expect(keysOf("branch.open")).toEqual(["Ctrl", "Shift", "L"]);
    await user.click(screen.getByRole("button", { name: "Reset the keys of “Open a branch”" }));
    expect(keysOf("branch.open")).toEqual(["Ctrl", "B"]);
    expect(screen.getByText("“Open a branch” is back to Ctrl+B.")).toBeInTheDocument();
    expect(prefsStore.get().keybindings).toEqual({ "notes.add": "Alt+N" });
    fireEvent.keyDown(document.body, { key: "b", code: "KeyB", ctrlKey: true });
    expect(onBranch).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Reset all keys" }));
    expect(prefsStore.get().keybindings).toEqual({});
    expect(screen.getByRole("button", { name: "Reset all keys" })).toBeDisabled();
  });

  it("recording a command's default keys again is no override", async () => {
    const user = userEvent.setup();
    prefsStore.update({ keybindings: { "branch.open": "Mod+Shift+L" } });
    setup();
    await user.click(recorder("Open a branch"));
    fireEvent.keyDown(recorder("Open a branch"), { key: "b", code: "KeyB", ctrlKey: true });
    expect(prefsStore.get().keybindings).toEqual({});
  });
});

describe("the send shortcut (Settings → Chat) reaches the message box", () => {
  const box = () => screen.getByRole("textbox", { name: "Message" });

  it("Enter sends by default, and the hint says so", () => {
    const { onSend } = setup();
    expect(screen.getByText(/^Enter to send · Shift\+Enter for a new line/)).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("with Ctrl+Enter chosen, Enter breaks the line and Ctrl+Enter sends; the hint and the list follow", () => {
    prefsStore.update({ sendShortcut: "mod_enter" });
    const { onSend } = setup();
    const enter = fireEvent.keyDown(box(), { key: "Enter" });
    // Not prevented: the text field breaks the line itself.
    expect(enter).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(screen.getByText("Ctrl+Enter to send · Enter for a new line · Ctrl+B to branch")).toBeInTheDocument();
    expect(keysOf("composer.send")).toEqual(["Ctrl", "Enter"]);
    expect(keysOf("composer.newline")).toEqual(["Enter"]);
    // ⌘/Ctrl+Enter is the send key now, so "end and bring back" has none until it is given other keys.
    expect(within(rowOf("branch.bringBack")).getByText("Taken by another command")).toBeInTheDocument();
  });

  it("switching back takes effect at once", () => {
    prefsStore.update({ sendShortcut: "mod_enter" });
    const { onSend } = setup();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    act(() => prefsStore.update({ sendShortcut: "enter" }));
    expect(screen.getByText(/^Enter to send · Shift\+Enter for a new line/)).toBeInTheDocument();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("the reader's own send key (Keybindings) wins over the send shortcut", async () => {
    const user = userEvent.setup();
    const { onSend } = setup();
    await user.click(recorder("Send"));
    fireEvent.keyDown(recorder("Send"), { key: "Enter", code: "Enter", altKey: true });
    expect(prefsStore.get().keybindings).toEqual({ "composer.send": "Alt+Enter" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter", altKey: true });
    expect(onSend).toHaveBeenCalledWith("hello");
    expect(screen.getByText(/^Alt\+Enter to send/)).toBeInTheDocument();
  });
});
