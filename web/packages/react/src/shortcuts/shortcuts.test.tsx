import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TangentRoot } from "../root/tangent-root";
import type { BindingOverrides } from "./commands";
import { CommandPalette, filterPaletteEntries } from "./command-palette";
import { ESCAPE_PRIORITY } from "./registry";
import { ShortcutKeys, ShortcutsProvider, useCommand, useEscapeLayer, useShortcutMatcher } from "./shortcuts-provider";

function Commands({ onBranch, onSidebar, onBack }: { onBranch: () => void; onSidebar: () => void; onBack?: () => void }) {
  useCommand("branch.open", onBranch);
  useCommand("sidebar.toggle", onSidebar);
  useCommand("nav.back", onBack ?? (() => {}));
  return (
    <>
      <input aria-label="Composer" />
      <button type="button">plain</button>
      <div role="dialog" aria-label="Inner dialog">
        <button type="button">in dialog</button>
      </div>
      <ShortcutKeys command="branch.open" />
    </>
  );
}

interface SetupOptions {
  bindings?: BindingOverrides;
  platform?: "apple" | "other";
  target?: "root" | "window";
  children?: ReactNode;
}

function setup(options: SetupOptions = {}) {
  const onBranch = vi.fn();
  const onSidebar = vi.fn();
  const onBack = vi.fn();
  const onWarning = vi.fn();
  const view = render(
    <TangentRoot aria-label="Tangent">
      <ShortcutsProvider bindings={options.bindings} platform={options.platform ?? "other"} target={options.target} onWarning={onWarning}>
        <Commands onBranch={onBranch} onSidebar={onSidebar} onBack={onBack} />
        <CommandPalette />
        {options.children}
      </ShortcutsProvider>
    </TangentRoot>,
  );
  const inside = screen.getByRole("button", { name: "plain" });
  return { onBranch, onSidebar, onBack, onWarning, inside, view };
}

const ctrl = (key: string, code: string, extra: Record<string, unknown> = {}) => ({ key, code, ctrlKey: true, ...extra });

describe("ShortcutsProvider: where keys are heard", () => {
  it("runs a registered command from keys inside its TangentRoot (Ctrl on Windows / Linux)", () => {
    const { onBranch, inside } = setup();
    fireEvent.keyDown(inside, ctrl("b", "KeyB"));
    expect(onBranch).toHaveBeenCalledOnce();
    fireEvent.keyDown(inside, { key: "b", code: "KeyB", metaKey: true });
    expect(onBranch).toHaveBeenCalledOnce();
  });

  it("ignores keys outside its root by default, so the host page keeps its own (F0 review H3)", () => {
    const { onBranch } = setup();
    fireEvent.keyDown(document.body, ctrl("b", "KeyB"));
    fireEvent.keyDown(window, ctrl("b", "KeyB"));
    expect(onBranch).not.toHaveBeenCalled();
  });

  it("fires once per instance: two embedded roots never both react", () => {
    const first = vi.fn();
    const second = vi.fn();
    function Instance({ name, onBranch }: { name: string; onBranch: () => void }) {
      return (
        <TangentRoot>
          <ShortcutsProvider platform="other">
            <Registered onBranch={onBranch} />
            <button type="button">{name}</button>
          </ShortcutsProvider>
        </TangentRoot>
      );
    }
    function Registered({ onBranch }: { onBranch: () => void }) {
      useCommand("branch.open", onBranch);
      return null;
    }
    render(
      <>
        <Instance name="one" onBranch={first} />
        <Instance name="two" onBranch={second} />
      </>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "two" }), ctrl("b", "KeyB"));
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
  });

  it("listens on the window when the app opts in with target=window", () => {
    const { onBranch } = setup({ target: "window" });
    fireEvent.keyDown(document.body, ctrl("b", "KeyB"));
    expect(onBranch).toHaveBeenCalledOnce();
  });

  it("removes its listener on unmount", () => {
    const { onBranch, inside, view } = setup({ target: "window" });
    view.unmount();
    fireEvent.keyDown(inside, ctrl("b", "KeyB"));
    fireEvent.keyDown(window, ctrl("b", "KeyB"));
    expect(onBranch).not.toHaveBeenCalled();
  });
});

describe("ShortcutsProvider: which keys fire", () => {
  it("uses ⌘ on Apple and shows the keys accordingly", () => {
    const { onBranch, inside } = setup({ platform: "apple" });
    fireEvent.keyDown(inside, { key: "b", code: "KeyB", metaKey: true });
    expect(onBranch).toHaveBeenCalledOnce();
    expect(screen.getByText("⌘").tagName).toBe("KBD");
  });

  it("fires ⌘/Ctrl combinations from a focused text field, never plain keys, never while composing", () => {
    const { onBranch, onBack } = setup();
    const composer = screen.getByRole("textbox", { name: "Composer" });
    composer.focus();
    fireEvent.keyDown(composer, ctrl("b", "KeyB", { isComposing: true }));
    fireEvent.keyDown(composer, { key: "Process", code: "KeyB", ctrlKey: true, keyCode: 229 });
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, ctrl("b", "KeyB"));
    expect(onBranch).toHaveBeenCalledOnce();
    fireEvent.keyDown(composer, { key: "Escape", code: "Escape" });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("inside a dialog or menu, only the palette fires", async () => {
    const { onBranch } = setup();
    const inDialog = screen.getByRole("button", { name: "in dialog" });
    fireEvent.keyDown(inDialog, ctrl("b", "KeyB"));
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.keyDown(inDialog, ctrl("k", "KeyK"));
    expect(await screen.findByRole("combobox", { name: "Command palette" })).toBeInTheDocument();
  });

  it("follows a non-Latin layout through the physical key", () => {
    const { onBranch, inside } = setup();
    fireEvent.keyDown(inside, ctrl("и", "KeyB"));
    expect(onBranch).toHaveBeenCalledOnce();
  });

  it("does not repeat a toggle while the key is held", () => {
    const { onSidebar, inside } = setup();
    fireEvent.keyDown(inside, ctrl(".", "Period"));
    fireEvent.keyDown(inside, ctrl(".", "Period", { repeat: true }));
    expect(onSidebar).toHaveBeenCalledOnce();
  });

  it("does not hear composer-scope keys, even with a handler registered", () => {
    const onSend = vi.fn();
    function Send() {
      useCommand("composer.send", onSend);
      return null;
    }
    const { inside } = setup({ children: <Send /> });
    fireEvent.keyDown(inside, { key: "Enter", code: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("applies host rebinding and disabling", () => {
    const { onBranch, onSidebar, inside } = setup({ bindings: { "branch.open": "Mod+Shift+B", "sidebar.toggle": null } });
    fireEvent.keyDown(inside, ctrl("b", "KeyB"));
    expect(onBranch).not.toHaveBeenCalled();
    fireEvent.keyDown(inside, ctrl("B", "KeyB", { shiftKey: true }));
    expect(onBranch).toHaveBeenCalledOnce();
    fireEvent.keyDown(inside, ctrl(".", "Period"));
    expect(onSidebar).not.toHaveBeenCalled();
  });

  it("keeps the palette when an override tries to take its keys (F0 review M4)", async () => {
    const { onBranch, onWarning, inside } = setup({ bindings: { "branch.open": "Mod+K" } });
    fireEvent.keyDown(inside, ctrl("k", "KeyK"));
    expect(await screen.findByRole("combobox", { name: "Command palette" })).toBeInTheDocument();
    expect(onBranch).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalled();
  });

  it("renders with a malformed binding, warns and keeps the default (F0 review M5)", () => {
    const { onBranch, onWarning, inside } = setup({ bindings: { "branch.open": "Cmd+Q" } });
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('"Cmd+Q"'));
    fireEvent.keyDown(inside, ctrl("b", "KeyB"));
    expect(onBranch).toHaveBeenCalledOnce();
  });

  it("leaves events another handler already took", () => {
    const { onBranch, inside } = setup();
    const event = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, cancelable: true, bubbles: true });
    event.preventDefault();
    act(() => {
      inside.dispatchEvent(event);
    });
    expect(onBranch).not.toHaveBeenCalled();
  });

  it("does nothing for a command without a registered handler", () => {
    const { inside } = setup();
    const event = new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    act(() => {
      inside.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("Escape layers (F0 review M6)", () => {
  function Layer({ name, priority, onEscape }: { name: string; priority: number; onEscape: (name: string) => void }) {
    useEscapeLayer(true, () => onEscape(name), priority);
    return null;
  }

  it("an open panel takes Esc before nav.back, the highest and newest layer first", () => {
    const calls: string[] = [];
    const { onBack, inside, view } = setup({
      children: (
        <>
          <Layer name="panel" priority={ESCAPE_PRIORITY.panel} onEscape={(name) => calls.push(name)} />
          <Layer name="overlay" priority={ESCAPE_PRIORITY.overlay} onEscape={(name) => calls.push(name)} />
        </>
      ),
    });
    fireEvent.keyDown(inside, { key: "Escape", code: "Escape" });
    expect(calls).toEqual(["overlay"]);
    expect(onBack).not.toHaveBeenCalled();
    view.unmount();
  });

  it("falls through to nav.back when no layer is open", () => {
    const { onBack, inside } = setup();
    fireEvent.keyDown(inside, { key: "Escape", code: "Escape" });
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("useShortcutMatcher (composer scope)", () => {
  function Composer({ onSend }: { onSend: () => void }) {
    const matches = useShortcutMatcher();
    return (
      <textarea
        aria-label="Message"
        onKeyDown={(event) => {
          if (matches(event, "composer.send")) {
            event.preventDefault();
            onSend();
          }
        }}
      />
    );
  }

  it("matches Enter but not Shift+Enter or Enter during composition", () => {
    const onSend = vi.fn();
    render(
      <ShortcutsProvider platform="other">
        <Composer onSend={onSend} />
      </ShortcutsProvider>,
    );
    const area = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(area, { key: "Enter", isComposing: true });
    fireEvent.keyDown(area, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });
});

describe("CommandPalette", () => {
  it("opens with Ctrl+K, lists runnable commands and runs the chosen one after closing", async () => {
    const { onSidebar, inside } = setup();
    inside.focus();
    fireEvent.keyDown(inside, ctrl("k", "KeyK"));
    const input = await screen.findByRole("combobox", { name: "Command palette" });
    await waitFor(() => expect(input).toHaveFocus());
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Open a branchCtrl+B", "Toggle the side panelCtrl+."]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options[1]!.id);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(onSidebar).toHaveBeenCalledOnce();
  });

  it("returns focus to where it was when closed with Esc", async () => {
    const { inside } = setup();
    inside.focus();
    fireEvent.keyDown(inside, ctrl("k", "KeyK"));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    await waitFor(() => expect(inside).toHaveFocus());
  });

  it("filters by the typed words and shows an empty state", async () => {
    const { inside } = setup();
    fireEvent.keyDown(inside, ctrl("k", "KeyK"));
    const input = await screen.findByRole("combobox");
    await userEvent.type(input, "side");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Toggle the side panelCtrl+."]);
    await userEvent.clear(input);
    await userEvent.type(input, "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching command.")).toBeInTheDocument();
  });

  it("stays available when the host turns its keys off", async () => {
    const { inside } = setup({ bindings: { "palette.open": null } });
    fireEvent.keyDown(inside, ctrl("k", "KeyK"));
    expect(await screen.findByRole("combobox")).toBeInTheDocument();
  });

  it("does not run a command on Enter while the IME is composing", async () => {
    const { onBranch, inside } = setup();
    fireEvent.keyDown(inside, ctrl("k", "KeyK"));
    const input = await screen.findByRole("combobox");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(onBranch).not.toHaveBeenCalled();
  });

  it("filterPaletteEntries matches every word against title and id", () => {
    const entries = [
      { id: "branch.open", title: "開支線", keys: null },
      { id: "turn.preview", title: "送出前預覽", keys: null },
    ];
    expect(filterPaletteEntries(entries, "支線").map((entry) => entry.id)).toEqual(["branch.open"]);
    expect(filterPaletteEntries(entries, "turn 預覽").map((entry) => entry.id)).toEqual(["turn.preview"]);
    expect(filterPaletteEntries(entries, "  ")).toHaveLength(2);
  });
});

describe("useCommand", () => {
  it("unregisters on unmount and always calls the latest handler", () => {
    const calls: string[] = [];
    function Toggle() {
      const [label, setLabel] = useState("first");
      useCommand("branch.open", () => calls.push(label));
      return (
        <button type="button" onClick={() => setLabel("second")}>
          change
        </button>
      );
    }
    function App({ mounted }: { mounted: boolean }) {
      return (
        <ShortcutsProvider platform="other" target="window">
          {mounted && <Toggle />}
        </ShortcutsProvider>
      );
    }
    const { rerender } = render(<App mounted />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.keyDown(window, ctrl("b", "KeyB"));
    rerender(<App mounted={false} />);
    fireEvent.keyDown(window, ctrl("b", "KeyB"));
    expect(calls).toEqual(["second"]);
  });

  it("lets a nested registration win and restores the previous one on unmount", () => {
    const calls: string[] = [];
    function Reg({ name }: { name: string }) {
      useCommand("branch.open", () => calls.push(name));
      return null;
    }
    function App({ inner }: { inner: boolean }) {
      return (
        <ShortcutsProvider platform="other" target="window">
          <Reg name="outer" />
          {inner && <Reg name="inner" />}
        </ShortcutsProvider>
      );
    }
    const { rerender } = render(<App inner />);
    fireEvent.keyDown(window, ctrl("b", "KeyB"));
    rerender(<App inner={false} />);
    fireEvent.keyDown(window, ctrl("b", "KeyB"));
    expect(calls).toEqual(["inner", "outer"]);
  });
});
