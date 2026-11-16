import { NAS_ROOT_ID, nasScenario, type MockTangentClient } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import TermDialog, { type SaveTermRequest } from "./term-dialog";

/** F19 §2.1: 存進名詞表, prefilled from where it was asked; a term already there is overwritten or left. */

const clients: MockTangentClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

function tracked(options: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient(options);
  clients.push(client);
  return client;
}

async function answeredAside(client: MockTangentClient, purpose: string, excerpt = "") {
  const made = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "aside", ...(excerpt ? { excerpt } : {}) });
  await client.sendMessage(made.line.id, { content: purpose });
  await waitFor(async () => expect((await client.getBranch(made.line.id)).branch.status).toBe("discarded"));
  return made.line.id;
}

function open(client: MockTangentClient, request: SaveTermRequest) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(<TermDialog open onOpenChange={onOpenChange} request={request} onSaved={onSaved} />, { wrapper: tangentWrapper(client) });
  return { onSaved, onOpenChange };
}

const dialog = () => screen.findByRole("dialog", { name: "Save to glossary" });
const fields = async () => {
  const box = await dialog();
  return { box, term: within(box).getByRole("textbox", { name: "Term" }), explanation: within(box).getByRole("textbox", { name: "Explanation" }) };
};

describe("TermDialog", () => {
  it("starts from an answered aside with the words it was asked about and its answer, saves, and the aside is kept", async () => {
    // Arrange
    const client = tracked();
    const asideId = await answeredAside(client, "解釋 scrub", "scrub");
    const answer = (await client.listMessages(asideId)).messages.find((message) => message.role === "assistant")!;
    const { onSaved, onOpenChange } = open(client, { lineId: asideId });
    const { box, term, explanation } = await fields();

    // Assert: the prefill.
    expect(term).toHaveValue("scrub");
    expect(explanation).toHaveValue(answer.content);

    // Act
    await userEvent.click(within(box).getByRole("button", { name: "Save to glossary" }));

    // Assert
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ change: "created", term: expect.objectContaining({ term: "scrub", sourceLineId: asideId, sourceMessageId: answer.id }) })));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((await client.getBranch(asideId)).branch.keptAt).toEqual(expect.any(String));
  });

  it("falls back to the aside's purpose when no words were selected for it", async () => {
    const client = tracked();
    const asideId = await answeredAside(client, "What is a scrub?");
    open(client, { lineId: asideId });
    expect((await fields()).term).toHaveValue("What is a scrub?");
  });

  it("takes a short selection as the term, and a message's menu as the explanation with the term left to write", async () => {
    // Arrange
    const client = tracked();
    const message = (await client.listMessages(NAS_ROOT_ID)).messages.find((item) => item.role === "assistant" && item.content.includes("ZFS"))!;

    // Act: the selection toolbar.
    const first = open(client, { lineId: NAS_ROOT_ID, messageId: message.id, selection: "ZFS" });
    const picked = await fields();

    // Assert
    expect(picked.term).toHaveValue("ZFS");
    expect((picked.explanation as HTMLTextAreaElement).value).toContain("ZFS");
    cleanup();

    // Act: the message's 「⋯」.
    open(client, { lineId: NAS_ROOT_ID, messageId: message.id });
    const whole = await fields();

    // Assert
    expect(whole.term).toHaveValue("");
    expect(whole.explanation).toHaveValue(message.content.trim());
    // An empty term is said only once a save was tried, and nothing is sent.
    const createTerm = vi.spyOn(client, "createTerm");
    expect(within(whole.box).queryByText("Enter the term.")).toBeNull();
    await userEvent.click(within(whole.box).getByRole("button", { name: "Save to glossary" }));
    expect(await within(whole.box).findByText("Enter the term.")).toBeInTheDocument();
    expect(createTerm).not.toHaveBeenCalled();
    expect(first.onSaved).not.toHaveBeenCalled();
  });

  it("shows the stored explanation when the term is already there; 覆寫 saves again with replace, 取消 changes nothing", async () => {
    // Arrange
    const client = tracked();
    await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "The old explanation." });
    const createTerm = vi.spyOn(client, "createTerm");
    const { onSaved, onOpenChange } = open(client, { lineId: NAS_ROOT_ID });
    const { box, term, explanation } = await fields();
    await userEvent.type(term, "z f s");
    await userEvent.type(explanation, "The new explanation.");

    // Act: the first save is refused.
    await userEvent.click(within(box).getByRole("button", { name: "Save to glossary" }));

    // Assert: what is there now, and the two ways on.
    const conflict = await within(box).findByRole("alert");
    expect(conflict).toHaveTextContent("This conversation's glossary already has “ZFS”.");
    expect(conflict).toHaveTextContent("The old explanation.");
    expect(within(box).queryByRole("button", { name: "Save to glossary" })).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();

    // Act: overwrite.
    await userEvent.click(within(box).getByRole("button", { name: "Overwrite" }));

    // Assert
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ change: "updated", term: expect.objectContaining({ term: "ZFS", explanation: "The new explanation." }) })));
    expect(createTerm.mock.calls.map(([, input]) => input.replace ?? false)).toEqual([false, true]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect((await client.listTerms(NAS_ROOT_ID)).terms).toHaveLength(1);
  });

  it("goes back to an ordinary save when the term is changed away from the one already there", async () => {
    const client = tracked();
    await client.createTerm(NAS_ROOT_ID, { term: "ZFS", explanation: "old" });
    const { onSaved } = open(client, { lineId: NAS_ROOT_ID });
    const { box, term, explanation } = await fields();
    await userEvent.type(term, "ZFS");
    await userEvent.type(explanation, "new");
    await userEvent.click(within(box).getByRole("button", { name: "Save to glossary" }));
    await within(box).findByRole("button", { name: "Overwrite" });
    await userEvent.type(term, " mirror");
    expect(within(box).queryByRole("alert")).toBeNull();
    await userEvent.click(within(box).getByRole("button", { name: "Save to glossary" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ change: "created", term: expect.objectContaining({ term: "ZFS mirror" }) })));
    expect((await client.listTerms(NAS_ROOT_ID)).terms.find((item) => item.term === "ZFS")?.explanation).toBe("old");
  });

  it("says a text over its limit as it is typed and that the glossary is full when the server says so", async () => {
    // Arrange
    const full = Array.from({ length: 300 }, (_, index) => ({ id: `t${index}`, rootLineId: NAS_ROOT_ID, term: `t${index}`, termKey: `t${index}`, explanation: "x", sourceLineId: "", sourceMessageId: "", sourceLabel: "", createdBy: "", createdAt: "", updatedAt: "" }));
    const client = tracked({ scenario: { ...nasScenario(), terms: full } });
    open(client, { lineId: NAS_ROOT_ID });
    const { box, term, explanation } = await fields();

    // Act and assert: too long, at once.
    await userEvent.click(term);
    await userEvent.paste("字".repeat(61));
    expect(await within(box).findByText("At most 60 characters.")).toBeInTheDocument();

    // Act and assert: full.
    await userEvent.clear(term);
    await userEvent.type(term, "one more");
    await userEvent.type(explanation, "x");
    await userEvent.click(within(box).getByRole("button", { name: "Save to glossary" }));
    expect(await within(box).findByText(/glossary is full \(300 terms\)/)).toBeInTheDocument();
  });
});
