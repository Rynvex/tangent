import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Plus } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { IconButton } from "./icon-button";

describe("Button", () => {
  it("is a type=button with the variant's classes and runs onClick", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Bring back
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Bring back" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toContain("bg-tg-primary");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("works from the keyboard (Enter and Space)", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    await userEvent.tab();
    expect(screen.getByRole("button")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("while loading: keeps focus, says Working…, is aria-busy / aria-disabled and ignores presses", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Working…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    // The label stays in the layout (invisible) so the width does not jump.
    expect(screen.getByText("Save").className).toContain("invisible");
  });

  it("uses a custom loading text and passes through disabled", () => {
    render(
      <>
        <Button loading loadingText="Drafting…">
          Draft
        </Button>
        <Button disabled>Off</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Drafting…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Off" })).toBeDisabled();
  });

  it("styles the destructive variant with the error tokens only", () => {
    render(<Button variant="destructive">Delete</Button>);
    const className = screen.getByRole("button").className;
    expect(className).toContain("bg-tg-destructive-soft");
    expect(className).toContain("text-tg-destructive");
  });
});

describe("IconButton", () => {
  it("is named by its label and reports pressed state", () => {
    render(<IconButton label="Toggle side panel" icon={<Plus />} pressed tooltip={false} />);
    const button = screen.getByRole("button", { name: "Toggle side panel" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("has a filled round variant for primary actions", () => {
    render(<IconButton label="Send" icon={<Plus />} variant="primary" round tooltip={false} />);
    const className = screen.getByRole("button", { name: "Send" }).className;
    expect(className).toContain("bg-tg-primary");
    expect(className).toContain("rounded-tg-full");
    expect(className).not.toContain("text-tg-muted");
  });

  it("shows its label as a tooltip on keyboard focus", async () => {
    render(<IconButton label="New conversation" icon={<Plus />} />);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "New conversation" })).toHaveFocus();
    expect(await screen.findByText("New conversation", { selector: "[data-open] *, [data-open]" })).toBeInTheDocument();
  });
});
