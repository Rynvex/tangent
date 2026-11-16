// @vitest-environment jsdom
import { normalizeLine } from "@tangent/client";
import { createMockTangentClient, nasScenario } from "@tangent/client/testing";
import { TangentProvider } from "@tangent/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MODEL_PREFS, modelPrefs, withFavorite } from "./model-prefs";
import { DEFAULT_PREFS, prefsStore, usePrefs } from "./prefs";
import { PrefsProviders } from "./prefs-apply";
import { SettingsDialog, type SettingsDialogProps } from "./settings-dialog";

const mocks: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of mocks.splice(0)) client.mock.dispose();
  prefsStore.reset();
  modelPrefs.set(EMPTY_MODEL_PREFS);
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** As in the app: the providers read the page's preferences, so a change in the dialog reaches them. */
function Wired({ children }: { children: ReactNode }) {
  return <PrefsProviders prefs={usePrefs()}>{children}</PrefsProviders>;
}

function setup(props: Partial<SettingsDialogProps> = {}, scenario = nasScenario()) {
  const client = createMockTangentClient({ latencyMs: 0, scenario });
  mocks.push(client);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TangentProvider client={client} locale="en">
        <Wired>{children}</Wired>
      </TangentProvider>
    </QueryClientProvider>
  );
  const line = normalizeLine({ id: "nas", title: "NAS", provider: "anthropic", model: "claude-sonnet-4-5" });
  const onOpenChange = vi.fn();
  render(<SettingsDialog open onOpenChange={onOpenChange} embedded={false} line={line} {...props} />, { wrapper });
  return { client, onOpenChange };
}

/** The dialog's name is its path, "Settings / <category>" (the test library drops the spaces around the separator). */
const pathTo = (name: string) => new RegExp(`^Settings\\s*/\\s*${name}$`);
const dialogOf = () => screen.findByRole("dialog", { name: /^Settings/ });
const category = (dialog: HTMLElement, name: string) => within(within(dialog).getByRole("navigation", { name: "Settings categories" })).getByRole("button", { name });
const row = (dialog: HTMLElement, id: string) => dialog.querySelector<HTMLElement>(`[data-setting="${id}"]`)!;

describe("SettingsDialog: the frame (G2)", () => {
  it("opens on General, with nine categories in three groups and the path on top", async () => {
    setup();
    const dialog = await dialogOf();
    expect(dialog).toHaveAccessibleName(pathTo("General"));
    const nav = within(dialog).getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getAllByRole("group").map((group) => group.getAttribute("aria-label"))).toEqual(["Basics", "Models and conversations", "System and archive"]);
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(["General", "Appearance", "Chat", "Keybindings", "Providers", "Threads", "Maintenance", "Archive", "About"]);
    expect(category(dialog, "General")).toHaveAttribute("aria-current", "page");
    // Focus starts on the category in view, not in the search box (no keyboard pops up on a phone).
    await waitFor(() => expect(category(dialog, "General")).toHaveFocus());
    expect(within(dialog).getByRole("region", { name: "General" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Notifications" })).toBeInTheDocument();
  });

  it("switches category from the navigation", async () => {
    setup();
    const dialog = await dialogOf();
    await userEvent.click(category(dialog, "Appearance"));
    expect(dialog).toHaveAccessibleName(pathTo("Appearance"));
    expect(category(dialog, "Appearance")).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByRole("radiogroup", { name: "Chat width" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Notifications" })).toBeNull();
    await userEvent.click(category(dialog, "About"));
    expect(within(dialog).getByText("v0.1.0")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "GitHub repository" })).toHaveAttribute("href", "https://github.com/Rynvex/tangent");
    expect(within(dialog).getByRole("link", { name: "MIT" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("can open on a category", async () => {
    setup({ initialCategory: "chat" });
    const dialog = await dialogOf();
    expect(within(dialog).getByRole("radiogroup", { name: "Send shortcut" })).toBeInTheDocument();
  });
});

describe("SettingsDialog: search", () => {
  it("filters every setting by name, description and keyword, and a result jumps to its category and lights the row", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await dialogOf();
    const search = within(dialog).getByRole("searchbox", { name: "Search settings" });
    await user.type(search, "wrap");
    const results = within(dialog).getByRole("region", { name: "Results" });
    expect(within(results).getAllByRole("button").map((button) => button.textContent)).toEqual(["Word wrap in code blocksAppearance"]);
    // The categories give way to the results while searching.
    expect(within(dialog).queryByRole("navigation", { name: "Settings categories" })).toBeNull();
    await user.click(within(results).getByRole("button", { name: /Word wrap in code blocks/ }));
    expect(dialog).toHaveAccessibleName(pathTo("Appearance"));
    expect(search).toHaveValue("");
    expect(category(dialog, "Appearance")).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(row(dialog, "codeWrap")).toHaveAttribute("data-highlighted", "true"));
    expect(row(dialog, "chatWidth")).not.toHaveAttribute("data-highlighted");
  });

  it("jumps to pages with parts of their own (Keybindings, Archive) too", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await dialogOf();
    await user.type(within(dialog).getByRole("searchbox", { name: "Search settings" }), "hotkey");
    await user.click(within(dialog).getByRole("button", { name: /Keybindings/ }));
    expect(dialog).toHaveAccessibleName(pathTo("Keybindings"));
    await waitFor(() => expect(row(dialog, "keybindings")).toHaveAttribute("data-highlighted", "true"));
  });

  it("focuses the search on /, takes the first result on Enter, and says when nothing matches", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await dialogOf();
    const search = within(dialog).getByRole("searchbox", { name: "Search settings" });
    await waitFor(() => expect(category(dialog, "General")).toHaveFocus());
    await user.keyboard("/");
    expect(search).toHaveFocus();
    // Typed into the box, a slash is only a character.
    await user.keyboard("a/b");
    expect(search).toHaveValue("a/b");
    expect(within(dialog).getByText("Nothing matches “a/b”.")).toHaveAttribute("role", "status");
    await user.clear(search);
    await user.type(search, "math{Enter}");
    expect(dialog).toHaveAccessibleName(pathTo("Appearance"));
    await waitFor(() => expect(row(dialog, "renderMath")).toHaveAttribute("data-highlighted", "true"));
  });

  it("Esc clears the search first and only then closes the dialog", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    const dialog = await dialogOf();
    const search = within(dialog).getByRole("searchbox", { name: "Search settings" });
    await user.type(search, "wrap");
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("SettingsDialog: the preference rows write the store the frame reads", () => {
  it("chooses the theme, the chat width, the code size and the cost threshold (with off)", async () => {
    setup({ initialCategory: "appearance" });
    const dialog = await dialogOf();
    const themes = within(dialog).getByRole("radiogroup", { name: "Theme" });
    expect(within(themes).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Light", "Dark", "Follow the system"]);
    expect(within(themes).getByRole("radio", { name: "Follow the system" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(themes).getByRole("radio", { name: "Dark" }));
    expect(prefsStore.get().theme).toBe("dark");
    expect(within(themes).getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    await userEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Chat width" })).getByRole("radio", { name: "Full" }));
    expect(prefsStore.get().chatWidth).toBe("full");
    await userEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Code font size" })).getByRole("radio", { name: "Large" }));
    expect(prefsStore.get().codeFontSize).toBe("lg");

    const costs = within(dialog).getByRole("radiogroup", { name: "Cost warning threshold" });
    expect(within(costs).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["US$0.02", "US$0.05", "US$0.10", "Off"]);
    await userEvent.click(within(costs).getByRole("radio", { name: "US$0.10" }));
    expect(prefsStore.get().costThreshold).toBe(0.1);
    await userEvent.click(within(costs).getByRole("radio", { name: "Off" }));
    expect(prefsStore.get().costThreshold).toBe("off");
    // Kept in this browser, under the versioned key.
    expect(JSON.parse(window.localStorage.getItem("tangent:prefs")!)).toMatchObject({ version: 2, theme: "dark", chatWidth: "full", codeFontSize: "lg", costThreshold: "off" });
  });

  it("chooses the reading font, modern sans by default, also when embedded; the theme is the host's then", async () => {
    setup({ embedded: true, initialCategory: "appearance" });
    const dialog = await dialogOf();
    const fonts = within(dialog).getByRole("radiogroup", { name: "Reading font" });
    expect(within(fonts).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Modern sans (default)", "Book serif"]);
    await userEvent.click(within(fonts).getByRole("radio", { name: "Book serif" }));
    expect(prefsStore.get().readingFont).toBe("serif");
    expect(within(dialog).queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    expect(within(dialog).getByText("The host decides the theme while embedded.")).toBeInTheDocument();
  });

  it("turns switches on and off; each is named and described by its row", async () => {
    setup();
    const dialog = await dialogOf();
    const remove = within(dialog).getByRole("switch", { name: "Delete confirmation" });
    expect(remove).toHaveAttribute("aria-checked", "true");
    expect(remove).toHaveAccessibleDescription(/deletes at once and cannot be undone/);
    await userEvent.click(remove);
    expect(remove).toHaveAttribute("aria-checked", "false");
    expect(prefsStore.get().confirmDelete).toBe(false);
    const archive = within(dialog).getByRole("switch", { name: "Archive confirmation" });
    expect(archive).toHaveAttribute("aria-checked", "false");
    archive.focus();
    await userEvent.keyboard(" ");
    expect(prefsStore.get().confirmArchive).toBe(true);
    await userEvent.click(within(dialog).getByRole("switch", { name: "Unpin confirmation" }));
    await userEvent.click(within(dialog).getByRole("switch", { name: "Show activity badges" }));
    await userEvent.click(within(dialog).getByRole("switch", { name: "In-app notifications" }));
    expect(prefsStore.get()).toMatchObject({ confirmUnpin: true, activityBadges: false, inAppNotifications: false });
  });

  it("chooses the time format and the language, and says when the address overrides one", async () => {
    setup({ langFromUrl: true });
    const dialog = await dialogOf();
    expect(within(within(dialog).getByRole("radiogroup", { name: "Time format" })).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Language’s own", "12-hour", "24-hour"]);
    await userEvent.click(within(dialog).getByRole("radio", { name: "12-hour" }));
    await userEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Interface language" })).getByRole("radio", { name: "繁體中文" }));
    expect(prefsStore.get()).toMatchObject({ timeFormat: "12h", language: "zh-TW" });
    expect(within(dialog).getByText(/address names a language/)).toBeInTheDocument();
  });

  it("asks the browser for notifications when they are turned on, and says what it answered", async () => {
    const requestPermission = vi.fn(() => Promise.resolve("granted" as NotificationPermission));
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
    setup();
    const dialog = await dialogOf();
    const group = within(dialog).getByRole("radiogroup", { name: "Thread notifications" });
    expect(within(group).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByText(/browser has not been asked/)).toBeNull();
    await userEvent.click(within(group).getByRole("radio", { name: "With sound" }));
    expect(prefsStore.get().threadNotifications).toBe("sound");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText("The browser has not been asked yet.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Allow notifications" }));
    await waitFor(() => expect(within(dialog).getByText("The browser allows notifications.")).toBeInTheDocument());
  });

  it("sets the chat behaviour: send shortcut, streaming, follow-up, aside default and card default", async () => {
    setup({ initialCategory: "chat" });
    const dialog = await dialogOf();
    const send = within(dialog).getByRole("radiogroup", { name: "Send shortcut" });
    expect(within(send).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Enter sends", "Ctrl+Enter sends"]);
    await userEvent.click(within(send).getByRole("radio", { name: "Ctrl+Enter sends" }));
    expect(prefsStore.get().sendShortcut).toBe("mod_enter");
    expect(within(dialog).getByText(/“End the branch and bring it back” loses Ctrl\+Enter|loses Ctrl\+Enter/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("switch", { name: "Streaming responses" }));
    await userEvent.click(within(dialog).getByRole("radio", { name: "Stop and send" }));
    await userEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Quick aside default" })).getByRole("radio", { name: "Kept" }));
    await userEvent.click(within(dialog).getByRole("switch", { name: "Auto-expand branch cards" }));
    expect(prefsStore.get()).toMatchObject({ streamResponses: false, followUp: "stop_and_send", asideDefault: "keep", expandCards: true });
  });
});

describe("SettingsDialog: Restore defaults", () => {
  it("asks first, then puts the settings and the model preferences back, and says so", async () => {
    const user = userEvent.setup();
    prefsStore.update({ theme: "dark", codeWrap: true, keybindings: { "branch.open": "Mod+Shift+L" } });
    modelPrefs.set(withFavorite(EMPTY_MODEL_PREFS, { provider: "anthropic", model: "claude-haiku-4-5" }, true));
    setup({ initialCategory: "appearance" });
    const dialog = await dialogOf();
    expect(within(dialog).getByRole("switch", { name: "Word wrap in code blocks" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(dialog).getByRole("button", { name: "Restore defaults" }));
    // Nothing changes until the second answer; 取消 has the focus.
    expect(prefsStore.get().theme).toBe("dark");
    const question = within(dialog).getByRole("group", { name: "Restore defaults" });
    expect(within(question).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    expect(prefsStore.get().theme).toBe("dark");
    await user.click(within(dialog).getByRole("button", { name: "Restore defaults" }));
    await user.click(within(within(dialog).getByRole("group", { name: "Restore defaults" })).getByRole("button", { name: "Restore" }));
    expect(prefsStore.get()).toEqual(DEFAULT_PREFS);
    expect(modelPrefs.get()).toEqual({ favorites: [], hidden: [] });
    expect(within(dialog).getByText("Every setting is back to its default.")).toHaveAttribute("role", "status");
    expect(within(dialog).getByRole("switch", { name: "Word wrap in code blocks" })).toHaveAttribute("aria-checked", "false");
  });

  it("Esc backs out of the question without closing the dialog", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = setup();
    const dialog = await dialogOf();
    await user.click(within(dialog).getByRole("button", { name: "Restore defaults" }));
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(within(dialog).getByRole("button", { name: "Restore defaults" })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
