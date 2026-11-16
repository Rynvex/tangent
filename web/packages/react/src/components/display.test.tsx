import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Badge, Kbd, Skeleton } from "./display";
import { Tab, Tabs, TabsList, TabsPanel } from "./tabs";

describe("Kbd, Badge, Skeleton", () => {
  it("Kbd renders a <kbd>; hint mode adds the touch-hiding class", () => {
    render(
      <>
        <Kbd>⌘ K</Kbd>
        <Kbd hint>Enter</Kbd>
      </>,
    );
    expect(screen.getByText("⌘ K").tagName).toBe("KBD");
    expect(screen.getByText("⌘ K").className).not.toContain("tg-kbd-hint");
    expect(screen.getByText("Enter").className).toContain("tg-kbd-hint");
  });

  it("Badge uses the tone's soft background and text token", () => {
    render(<Badge tone="warning">3</Badge>);
    expect(screen.getByText("3").className).toMatch(/bg-tg-warning-soft.*text-tg-warning/);
  });

  it("Skeleton is hidden from assistive tech and shimmers via tg-shimmer", () => {
    const { container } = render(<Skeleton className="h-4" />);
    const block = container.firstElementChild!;
    expect(block).toHaveAttribute("aria-hidden", "true");
    expect(block.className).toContain("tg-shimmer");
  });
});

describe("Tabs", () => {
  function Example({ onValueChange }: { onValueChange?: (value: unknown) => void }) {
    return (
      <Tabs defaultValue="structure" onValueChange={onValueChange}>
        <TabsList aria-label="Side panel">
          <Tab value="structure">Structure</Tab>
          <Tab value="notes">Notes</Tab>
          <Tab value="inbox">Inbox</Tab>
        </TabsList>
        <TabsPanel value="structure">Outline here</TabsPanel>
        <TabsPanel value="notes">Notes here</TabsPanel>
        <TabsPanel value="inbox">Inbox here</TabsPanel>
      </Tabs>
    );
  }

  it("is a labelled tablist whose panels follow the selected tab", async () => {
    const onValueChange = vi.fn();
    render(<Example onValueChange={onValueChange} />);
    expect(screen.getByRole("tablist", { name: "Side panel" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Structure" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Outline here");
    await userEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Notes here");
    expect(onValueChange).toHaveBeenCalledWith("notes", expect.anything());
  });

  it("moves between tabs with the arrow keys", async () => {
    render(<Example />);
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "Structure" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Notes" })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Inbox" })).toHaveFocus();
  });
});
