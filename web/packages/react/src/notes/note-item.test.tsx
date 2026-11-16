import { TangentError, type Note } from "@tangent/client";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { NoteItem, SupersededNoteItem } from "./note-item";

afterEach(cleanup);

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1", section: "fact", text: "2.1TB today", status: "active", sourceLineId: "root", sourceMessageId: "m3", sourceCardMessageId: "",
  supersededBy: "", createdBy: "u", createdAt: "", updatedAt: "", ...over,
});
const wrapper = () => tangentWrapper(mockClient(), undefined, { locale: "en" });

describe("NoteItem (A9)", () => {
  it("edits in place: click the text, Enter saves the trimmed text", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<NoteItem note={note()} onSave={onSave} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("button", { name: "2.1TB today" }));
    const box = screen.getByRole("textbox", { name: "Edit the note" });
    expect(box).toHaveFocus();
    await userEvent.clear(box);
    await userEvent.type(box, "  2.2TB today {Enter}");
    expect(onSave).toHaveBeenCalledWith("2.2TB today");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Esc cancels without saving and keeps the event from closing the panel", async () => {
    const onSave = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <NoteItem note={note()} onSave={onSave} />
      </div>,
      { wrapper: wrapper() },
    );
    await userEvent.click(screen.getByRole("button", { name: "2.1TB today" }));
    await userEvent.type(screen.getByRole("textbox"), "x{Escape}");
    expect(onSave).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
    expect(screen.getByRole("button", { name: "2.1TB today" })).toHaveFocus();
  });

  it("refuses an empty or too long text, and reopens with the server's refusal", async () => {
    const onSave = vi.fn(() => Promise.reject(new TangentError(409, "superseded", "note_superseded")));
    render(<NoteItem note={note()} onSave={onSave} maxRunes={5} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("button", { name: "2.1TB today" }));
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("A note cannot be empty.")).toBeInTheDocument();
    await userEvent.type(box, "123456{Enter}");
    expect(screen.getByText("At most 5 characters.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    await userEvent.type(box, "{Backspace}{Enter}");
    expect(onSave).toHaveBeenCalledWith("12345");
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("12345"));
    expect(screen.getByRole("textbox")).toHaveAccessibleDescription(/Not saved/);
  });

  it("marks a to-do done with its checkbox, and shows a done one struck through", async () => {
    const onToggleDone = vi.fn();
    const { rerender } = render(<NoteItem note={note({ section: "todo", text: "Buy a UPS" })} onToggleDone={onToggleDone} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("checkbox", { name: "Done: Buy a UPS" }));
    expect(onToggleDone).toHaveBeenCalledWith(true);
    rerender(<NoteItem note={note({ section: "todo", text: "Buy a UPS", status: "done" })} onToggleDone={onToggleDone} />);
    expect(screen.getByRole("checkbox", { name: "Done: Buy a UPS" })).toBeChecked();
    expect(screen.getByRole("listitem")).toHaveAttribute("data-status", "done");
  });

  it("replaces a note with new text", async () => {
    const onSupersede = vi.fn(() => Promise.resolve());
    render(<NoteItem note={note()} onSupersede={onSupersede} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    const box = screen.getByRole("textbox", { name: "New text (the old note stays, struck through)" });
    expect(box).toHaveValue("2.1TB today");
    await userEvent.clear(box);
    await userEvent.type(box, "2.3TB today");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSupersede).toHaveBeenCalledWith("2.3TB today", "fact");
  });

  it("replaces a to-confirm note into confirmed facts by default (R5)", async () => {
    const onSupersede = vi.fn(() => Promise.resolve());
    render(<NoteItem note={note({ section: "to_confirm", text: "ECC needed?" })} onSupersede={onSupersede} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    const sections = screen.getByRole("radiogroup", { name: "Section" });
    expect(within(sections).getByRole("radio", { name: "Confirmed facts" })).toBeChecked();
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "ECC is needed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSupersede).toHaveBeenCalledWith("ECC is needed", "fact");
  });

  it("keeps other sections by default and can move the replacement elsewhere (R5)", async () => {
    const onSupersede = vi.fn(() => Promise.resolve());
    render(<NoteItem note={note({ section: "decided", text: "Budget 30k" })} onSupersede={onSupersede} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    const sections = screen.getByRole("radiogroup", { name: "Section" });
    expect(within(sections).getByRole("radio", { name: "Decided" })).toBeChecked();
    await userEvent.click(within(sections).getByRole("radio", { name: "To do" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSupersede).toHaveBeenCalledWith("Budget 30k", "todo");
  });

  it("keeps the chosen section when a refused replacement reopens (R5)", async () => {
    const onSupersede = vi.fn(() => Promise.reject(new TangentError(409, "superseded", "note_superseded")));
    render(<NoteItem note={note({ section: "to_confirm", text: "ECC needed?" })} onSupersede={onSupersede} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await userEvent.click(screen.getByRole("radio", { name: "To do" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveAccessibleDescription(/Not saved/));
    expect(screen.getByRole("radio", { name: "To do" })).toBeChecked();
  });

  it("says why ticking a to-do failed (R5)", async () => {
    const onToggleDone = vi.fn(() => Promise.reject(new TangentError(409, "superseded", "note_superseded")));
    render(<NoteItem note={note({ section: "todo", text: "Buy a UPS" })} onToggleDone={onToggleDone} />, { wrapper: wrapper() });
    await userEvent.click(screen.getByRole("checkbox", { name: "Done: Buy a UPS" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Not saved/);
  });

  it("marks new notes and notes the prompt leaves out, and links the source", async () => {
    const onSource = vi.fn();
    render(<NoteItem note={note()} isNew leftOut source={{ label: "Main line #3", lineId: "root", messageId: "m3" }} onSource={onSource} />, { wrapper: wrapper() });
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Not sent this turn")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to the source: Main line #3" }));
    expect(onSource).toHaveBeenCalledWith("root", "m3");
  });

  it("is plain text for read-only identities", () => {
    render(<NoteItem note={note({ section: "todo", status: "done" })} readOnly source={{ label: "Source cleared", lineId: null }} />, { wrapper: wrapper() });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Source cleared")).toBeInTheDocument();
  });
});

describe("SupersededNoteItem", () => {
  it("strikes the old text through and names its replacement", () => {
    render(<SupersededNoteItem note={note({ status: "superseded" })} replacement={note({ id: "n2", text: "2.3TB today" })} />, { wrapper: wrapper() });
    expect(screen.getByText("2.1TB today").tagName).toBe("S");
    expect(screen.getByText("Replaced by “2.3TB today”")).toBeInTheDocument();
  });
});
