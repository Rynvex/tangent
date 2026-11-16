import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { IconButton } from "./icon-button";

afterEach(cleanup);

describe("IconButton's hint (F9: loaded on first use)", () => {
  it("has no hint until pointed at or focused; keyboard focus shows the label and shortcut", async () => {
    const client = mockClient();
    render(<IconButton label="Settings" icon={<span />} shortcut={<kbd>⌘,</kbd>} />, { wrapper: tangentWrapper(client) });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.querySelector("[data-tg-portal] *")).toBeNull();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
    expect(await screen.findByText("⌘,")).toBeInTheDocument();
    client.mock.dispose();
  });

  it("a hover hint closes on Esc with focus elsewhere (WCAG 1.4.13)", async () => {
    const client = mockClient();
    render(<IconButton label="Settings" icon={<span />} shortcut={<kbd>⌘,</kbd>} />, { wrapper: tangentWrapper(client) });
    await userEvent.hover(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("⌘,", undefined, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("⌘,")).toBeNull());
    client.mock.dispose();
  });

  it("never loads a hint with the tooltip turned off", async () => {
    const client = mockClient();
    render(<IconButton label="Close" icon={<span />} tooltip={false} />, { wrapper: tangentWrapper(client) });
    await userEvent.tab();
    await userEvent.hover(screen.getByRole("button", { name: "Close" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("Close")).toBeNull();
    client.mock.dispose();
  });

  it("never opens a hint when the trigger is behind an aria-hidden or inert container", async () => {
    const client = mockClient();
    render(
      <div aria-hidden="true">
        <IconButton label="HiddenAction" icon={<span />} shortcut={<kbd>⌘H</kbd>} />
      </div>,
      { wrapper: tangentWrapper(client) },
    );
    const button = screen.getByRole("button", { name: "HiddenAction", hidden: true });
    fireEvent.focus(button);
    await userEvent.hover(button);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(screen.queryByText("⌘H")).toBeNull();
    client.mock.dispose();
  });
});
