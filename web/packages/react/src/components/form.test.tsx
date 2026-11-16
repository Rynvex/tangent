import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./checkbox";
import { Select } from "./select";
import { TextArea, TextField } from "./text-field";

describe("TextField and TextArea", () => {
  it("wire the label, description and the input-border token", async () => {
    const onChange = vi.fn();
    render(<TextField label="Purpose" description="One sentence" placeholder="What to find out" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Purpose" });
    expect(input).toHaveAccessibleDescription("One sentence");
    expect(input.className).toContain("border-tg-border-input");
    await userEvent.type(input, "ZFS");
    expect(input).toHaveValue("ZFS");
    expect(onChange).toHaveBeenCalled();
  });

  it("mark the control invalid and announce the error", () => {
    render(<TextField label="Purpose" error="The purpose is required" />);
    const input = screen.getByRole("textbox", { name: "Purpose" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(expect.stringContaining("The purpose is required"));
  });

  it("TextArea is a labelled multi-line field", async () => {
    render(<TextArea label="Conclusion" rows={4} />);
    const area = screen.getByRole("textbox", { name: "Conclusion" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveAttribute("rows", "4");
    await userEvent.type(area, "a{Shift>}{Enter}{/Shift}b");
    expect(area).toHaveValue("a\nb");
  });

  it("passes disabled to the control", () => {
    render(<TextField label="Title" disabled />);
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
  });
});

const THRESHOLDS = [
  { value: "0.02", label: "US$0.02" },
  { value: "0.05", label: "US$0.05" },
  { value: "0.10", label: "US$0.10" },
] as const;

describe("Select", () => {
  it("is a labelled combobox that picks an option with the keyboard", async () => {
    const onValueChange = vi.fn();
    render(<Select label="Cost threshold" options={THRESHOLDS} defaultValue="0.05" onValueChange={onValueChange} />);
    const trigger = screen.getByRole("combobox", { name: "Cost threshold" });
    expect(trigger).toHaveTextContent("US$0.05");
    expect(trigger.className).toContain("border-tg-border-input");
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await waitFor(() => expect(screen.getByRole("option", { name: "US$0.05" })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("0.10");
    await waitFor(() => expect(trigger).toHaveTextContent("US$0.10"));
  });

  it("shows the placeholder until a value is chosen", () => {
    render(<Select aria-label="Mode" options={THRESHOLDS} placeholder="Pick one" />);
    expect(screen.getByRole("combobox", { name: "Mode" })).toHaveTextContent("Pick one");
  });
});

describe("Checkbox", () => {
  it("toggles from its label and from Space, reporting aria-checked", async () => {
    const onCheckedChange = vi.fn();
    render(<Checkbox onCheckedChange={onCheckedChange}>Include later messages</Checkbox>);
    const box = screen.getByRole("checkbox", { name: "Include later messages" });
    expect(box).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByText("Include later messages"));
    expect(box).toHaveAttribute("aria-checked", "true");
    box.focus();
    await userEvent.keyboard(" ");
    expect(box).toHaveAttribute("aria-checked", "false");
    expect(onCheckedChange.mock.calls.map(([checked]) => checked)).toEqual([true, false]);
  });

  it("supports aria-label without a visible label, and disabled", () => {
    render(<Checkbox aria-label="Select row" disabled />);
    const box = screen.getByRole("checkbox", { name: "Select row" });
    expect(box).toHaveAttribute("aria-disabled", "true");
    expect(box.className).toContain("border-tg-border-input");
  });

  it("gives an unlabelled box a hit area of --tg-hit-target (44px on touch, F0 review M12)", () => {
    render(<Checkbox aria-label="Select row" />);
    expect(screen.getByRole("checkbox").className).toContain("before:size-(--tg-hit-target)");
  });
});
