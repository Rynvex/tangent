import { TangentError, type BranchView, type LineView, type Message } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { OpenBranchDialog, type OpenBranchRequest } from "./open-branch-dialog";

const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.mock.dispose();
});

async function setup(request: OpenBranchRequest, options: { features?: "all" | "core"; branches?: BranchView[] } = {}) {
  const client = mockClient({ scenario: nasScenario({ features: options.features ?? "all" }) });
  clients.push(client);
  const line: LineView = await client.getLine(NAS_ROOT_ID);
  const messages: Message[] = (await client.listMessages(NAS_ROOT_ID)).messages;
  const branches = options.branches ?? (await client.listBranches(NAS_ROOT_ID)).branches;
  const onCreated = vi.fn();
  const create = vi.spyOn(client, "createBranch");
  render(<OpenBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} branches={branches} request={request} onCreated={onCreated} />, {
    wrapper: tangentWrapper(client),
  });
  const dialog = await screen.findByRole("dialog", { name: "Open a branch" });
  return { client, onCreated, create, dialog, messages };
}

describe("OpenBranchDialog", () => {
  it("D1: what was concluded before about the purpose can be ticked and goes into the branch's background", async () => {
    const { client, create, dialog } = await setup({ anchorMessageId: "nas-m18" });
    await client.createMemory({ kind: "decision", text: "UPS: buy a 600VA one" });
    const purpose = within(dialog).getByRole("textbox", { name: /Purpose/ });
    await userEvent.clear(purpose);
    await userEvent.type(purpose, "Which UPS to buy");
    const recall = await within(dialog).findByRole("group", { name: "Bring in what you concluded before" }, { timeout: 3000 });
    await userEvent.click(within(recall).getByRole("checkbox", { name: "Bring in “UPS: buy a 600VA one”" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1].excerpt).toContain("From earlier conversations:\n- [Decision] UPS: buy a 600VA one");
  });

  it("expands a parked seed (B3): its text is the question, no model or later-messages choice, and the seed becomes the branch", async () => {
    const { client, onCreated, create, dialog } = await setup({ anchorMessageId: "nas-m18", seed: { id: "nas-s1", text: "UPS 要不要買？" } });
    const expand = vi.spyOn(client, "expandSeed");
    const send = vi.spyOn(client, "sendMessage");
    expect(dialog).toHaveTextContent("From the parking lot");
    expect(within(dialog).getByRole("textbox", { name: "First question for the AI" })).toHaveValue("UPS 要不要買？");
    expect(within(dialog).queryByRole("radio", { name: "Why" })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).queryByText("Model")).toBeNull();
    await userEvent.click(await within(dialog).findByRole("radio", { name: /Aside/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Just open it, ask later" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(expand).toHaveBeenCalledWith("nas-s1", { purpose: "UPS 要不要買？", kind: "aside" });
    expect(onCreated.mock.calls[0]![0].branch).toMatchObject({ origin: "seed", anchorMessageId: "nas-m18" });
    expect(onCreated.mock.calls[0]![1]).toEqual({ question: "UPS 要不要買？", sent: false });
    expect((await client.listSeeds(NAS_ROOT_ID)).seeds.map((seed) => seed.id)).not.toContain("nas-s1");
  });

  it("F10: a seed is asked in its new branch at once", async () => {
    const { client, onCreated, dialog } = await setup({ anchorMessageId: "nas-m18", seed: { id: "nas-s1", text: "UPS 要不要買？" } });
    const send = vi.spyOn(client, "sendMessage");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch and ask" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const lineId = onCreated.mock.calls[0]![0].line.id;
    expect(send).toHaveBeenCalledWith(lineId, { content: "UPS 要不要買？" });
    expect(onCreated.mock.calls[0]![1]).toEqual({ question: "UPS 要不要買？", sent: true });
  });

  it("says when the seed was already used", async () => {
    const { client, dialog } = await setup({ anchorMessageId: "nas-m18", seed: { id: "nas-s1", text: "UPS 要不要買？" } });
    await client.dropSeed("nas-s1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Just open it, ask later" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This seed was already expanded, noted or dropped.");
  });

  it("F10: a selected sentence starts with 解釋原因 — the question and purpose filled in, sent in the new branch with the excerpt", async () => {
    const excerpt = "兩者都容許壞一顆碟。差別在擴充方式與重建風險";
    const { client, onCreated, create, dialog } = await setup({ anchorMessageId: "nas-m17", excerpt });
    const send = vi.spyOn(client, "sendMessage");
    expect(dialog).toHaveTextContent("From main line #2");
    expect(within(dialog).getByText(excerpt, { selector: "blockquote" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Why" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getAllByRole("radio", { name: /Why|A plain example|Counterpoints|Putting it to use/ })).toHaveLength(4);
    const question = `Why “${excerpt}”? Explain the reasoning behind it in detail.`;
    expect(within(dialog).getByRole("textbox", { name: "First question for the AI" })).toHaveValue(question);
    expect(within(dialog).queryByRole("textbox", { name: /Purpose/ })).toBeNull();
    expect(dialog).toHaveTextContent(`Check: ${excerpt}`);
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch and ask" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({ anchorMessageId: "nas-m17", kind: "investigate", purpose: `Check: ${excerpt}`, excerpt });
    expect(send).toHaveBeenCalledWith(onCreated.mock.calls[0]![0].line.id, { content: question });
    expect(onCreated.mock.calls[0]![1]).toEqual({ question, sent: true });
  });

  it("F10: a selected term offers its four templates; a chip switches the question and the purpose, an edited purpose stays", async () => {
    const { create, dialog } = await setup({ anchorMessageId: "nas-m17", excerpt: "「豪斯多夫維度」" });
    const box = within(dialog).getByRole("textbox", { name: "First question for the AI" });
    expect(box).toHaveValue("What is “豪斯多夫維度”? Explain it simply, with one example.");
    expect(dialog).toHaveTextContent("About: 豪斯多夫維度");
    await userEvent.click(within(dialog).getByRole("radio", { name: "What it is for" }));
    expect(box).toHaveValue("What problem is “豪斯多夫維度” mainly used to solve, and where is it used in practice?");
    expect(dialog).toHaveTextContent("Use: 豪斯多夫維度");
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit the purpose" }));
    const purpose = within(dialog).getByRole("textbox", { name: /Purpose/ });
    await userEvent.clear(purpose);
    await userEvent.type(purpose, "維度的用途");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Pros and cons" }));
    expect(purpose).toHaveValue("維度的用途");
    await userEvent.click(within(dialog).getByRole("button", { name: "Just open it, ask later" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({ purpose: "維度的用途" });
  });

  it("F10: without a selection the purpose follows what is typed, and an emptied question opens without asking", async () => {
    const { client, onCreated, create, dialog } = await setup({ anchorMessageId: "nas-m40" });
    const send = vi.spyOn(client, "sendMessage");
    const box = within(dialog).getByRole("textbox", { name: "First question for the AI" });
    expect(box).toHaveValue("");
    await userEvent.type(box, "我們每晚備份到 B2。如果改用 Wasabi，取回要另外付錢嗎？");
    // F11 §2: named after what it asks, not its first characters.
    expect(within(dialog).getByRole("textbox", { name: /Purpose/ })).toHaveValue("如果改用 Wasabi，取回要另外付錢嗎");
    await userEvent.clear(box);
    await userEvent.click(within(dialog).getByRole("radio", { name: "Alternatives" }));
    expect(box).toHaveValue("Besides the above, what alternatives are there, and what are their pros and cons?");
    await userEvent.clear(box);
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "B2");
    expect(within(dialog).queryByRole("button", { name: "Just open it, ask later" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({ purpose: "B2" });
    expect(send).not.toHaveBeenCalled();
  });

  it("F10: Enter in the question opens and asks; Shift+Enter is a new line", async () => {
    const { client, onCreated, dialog } = await setup({ anchorMessageId: "nas-m17", excerpt: "CAP 定理" });
    const send = vi.spyOn(client, "sendMessage");
    const box = within(dialog).getByRole("textbox", { name: "First question for the AI" });
    await userEvent.click(box);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onCreated).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("F10: a failed send still ends the dialog with the branch, and says why", async () => {
    const { client, onCreated, dialog } = await setup({ anchorMessageId: "nas-m17", excerpt: "CAP 定理" });
    vi.spyOn(client, "sendMessage").mockRejectedValueOnce(new TangentError(409, "busy", "turn_in_progress"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch and ask" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0]![1]).toMatchObject({ question: "What is “CAP 定理”? Explain it simply, with one example.", sent: false, sendError: expect.any(TangentError) });
  });

  it("F10: a question from the host (the Feynman check) offers no templates and keeps its purpose", async () => {
    const { dialog } = await setup({ anchorMessageId: "nas-m17", excerpt: "我的理解", purpose: "檢驗：我的理解", question: "請檢查我的理解" });
    expect(within(dialog).queryByRole("radiogroup", { name: "What to ask" })).toBeNull();
    expect(within(dialog).getByRole("textbox", { name: "First question for the AI" })).toHaveValue("請檢查我的理解");
    expect(dialog).toHaveTextContent("檢驗：我的理解");
  });

  it("requires a purpose", async () => {
    const { create, dialog } = await setup({ anchorMessageId: "nas-m40" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    expect(within(dialog).getByText("A purpose is required.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("names an accepted suggestion only while it is unchanged", async () => {
    const suggestion = { messageId: "nas-m40", purpose: "B2 與 Wasabi 的取回費用差異", kind: "investigate" as const };
    const { create, dialog } = await setup({ anchorMessageId: "nas-m40", suggestion });
    expect(within(dialog).getByText("Suggested by AI")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({ purpose: suggestion.purpose, suggestionMessageId: "nas-m40" });
  });

  it("asks before a deeper branch and opens it once confirmed", async () => {
    const { client, onCreated, create, dialog } = await setup({ anchorMessageId: "nas-m40" });
    create.mockRejectedValueOnce(new TangentError(409, "deeper", "depth_soft_limit", { depth: 4, limit: 3 }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "UPS");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This will be a level 4 branch");
    await userEvent.click(within(alert).getByRole("button", { name: "Open it anyway" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(create.mock.calls[1]![1]).toMatchObject({ confirmDeeper: true });
    expect(client).toBeDefined();
  });

  it("re-anchors on the last message when the fork point is gone", async () => {
    const { create, dialog } = await setup({ anchorMessageId: "nas-m17" });
    create.mockRejectedValueOnce(new TangentError(404, "gone", "anchor_not_found"));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "UPS");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The fork point is no longer on this line");
    await userEvent.click(within(alert).getByRole("button", { name: "Hang it on the last message" }));
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(dialog).toHaveTextContent("From main line #8");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![1]).toMatchObject({ anchorMessageId: "nas-m40" });
  });

  it("says when the line already has the most open branches, before sending", async () => {
    const full = Array.from({ length: 8 }, (_, i) => ({ lineId: `b${i}`, parentLineId: NAS_ROOT_ID, rootLineId: NAS_ROOT_ID, status: "open" }) as BranchView);
    const { create, dialog } = await setup({ anchorMessageId: "nas-m40" }, { branches: full });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("8 open branches");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "UPS");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("offers no aside when that feature is off, and brings later messages when asked", async () => {
    const { create, dialog } = await setup({ anchorMessageId: "nas-m26" }, { features: "core" });
    expect(within(dialog).queryByRole("radio", { name: /Aside/ })).toBeNull();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "UPS");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Also bring/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: /What the background brings/ }));
    expect(within(dialog).getByText("2 message(s) after the fork point")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Open branch" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![1]).toMatchObject({ includeLater: true });
  });
});

describe("OpenBranchDialog: the background from the server (B5 POST /branches/preview)", () => {
  it("shows the server's count of what the background brings, not an estimate", async () => {
    const { client, dialog } = await setup({ anchorMessageId: "nas-m17" });
    const preview = vi.spyOn(client, "previewBranch");
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "UPS");
    const toggle = await within(dialog).findByRole("button", { name: /What the background brings.*2\.4k token/ }, { timeout: 3000 });
    await userEvent.click(toggle);
    expect(within(dialog).getByText("Built by the server from the main line as it is now; it is built again when the branch opens.")).toBeInTheDocument();
    expect(within(dialog).queryByText(/A rough estimate/)).toBeNull();
    // Asked again once the purpose settles.
    await waitFor(() => expect(preview).toHaveBeenCalledWith(NAS_ROOT_ID, expect.objectContaining({ anchorMessageId: "nas-m17", purpose: "UPS", kind: "investigate" }), expect.anything()));
  });

  it("falls back to the rough estimate when the server has no preview route", async () => {
    const { client, dialog } = await setup({ anchorMessageId: "nas-m17" });
    vi.spyOn(client, "previewBranch").mockRejectedValue(new TangentError(404, "not found", "not_found"));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Purpose/ }), "UPS");
    await userEvent.click(await within(dialog).findByRole("button", { name: /What the background brings/ }));
    await waitFor(() => expect(within(dialog).getByText(/A rough estimate/)).toBeInTheDocument());
  });
});
