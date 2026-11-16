import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TangentRoot } from "../root/tangent-root";
import { Button } from "./button";
import { Dialog, DialogContent, DialogTrigger } from "./dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

describe("Dialog", () => {
  function Example({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
    return (
      <TangentRoot theme="dark">
        <Dialog onOpenChange={onOpenChange}>
          <DialogTrigger render={<Button>Open</Button>} />
          <DialogContent title="Open a branch" description="Ask a side question" footer={<Button variant="primary">Create</Button>}>
            <input aria-label="Purpose" />
          </DialogContent>
        </Dialog>
      </TangentRoot>
    );
  }

  it("opens a modal dialog named by its title and described by its description", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Open a branch" });
    expect(dialog).toHaveAccessibleDescription("Ask a side question");
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("renders inside the root's portal so it inherits the theme", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.closest("[data-tg-theme]")).toHaveAttribute("data-tg-theme", "dark");
    expect(dialog.closest("[data-tg-portal]")).not.toBeNull();
  });

  it("moves focus inside, closes on Esc and returns focus to the trigger", async () => {
    const onOpenChange = vi.fn();
    render(<Example onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onOpenChange).toHaveBeenLastCalledWith(false, expect.anything());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes from its labelled close button", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Popover", () => {
  it("toggles from its trigger with aria-expanded and closes on Esc", async () => {
    render(
      <Popover>
        <PopoverTrigger render={<Button>Peek</Button>} />
        <PopoverContent title="Fork point">
          <p>Message #18</p>
        </PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "Peek" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(await screen.findByText("Message #18")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog", { name: "Fork point" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Message #18")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("Menu", () => {
  function Example({ onCopy, onDelete }: { onCopy: () => void; onDelete: () => void }) {
    return (
      <Menu>
        <MenuTrigger render={<Button>Actions</Button>} />
        <MenuContent>
          <MenuItem onSelect={onCopy}>Copy</MenuItem>
          <MenuItem onSelect={onDelete} destructive>
            Delete
          </MenuItem>
          <MenuItem disabled>Archive</MenuItem>
        </MenuContent>
      </Menu>
    );
  }

  it("opens from the keyboard, moves with arrows and runs the chosen item", async () => {
    const onCopy = vi.fn();
    const onDelete = vi.fn();
    render(<Example onCopy={onCopy} onDelete={onDelete} />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(menu).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onCopy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus());
  });

  it("returns focus to the trigger on Esc and marks the highlighted item beyond its fill (F0 review M10)", async () => {
    render(<Example onCopy={vi.fn()} onDelete={vi.fn()} />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    const copy = await screen.findByRole("menuitem", { name: "Copy" });
    expect(copy.className).toContain("data-highlighted:shadow-[inset_3px_0_0_var(--tg-ring)]");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Actions" })).toHaveFocus());
  });

  it("marks disabled items and styles destructive ones with the error token", async () => {
    render(<Example onCopy={vi.fn()} onDelete={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(await screen.findByRole("menuitem", { name: "Archive" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("text-tg-destructive");
  });
});
