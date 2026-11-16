import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { divergeTargetPurpose, purposeHead, TangentError, type Message } from "@tangent/client";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DivergeDialog } from "../p3/diverge-dialog";
import { mockClient, tangentWrapper } from "../test-utils";
import { EditBranchDialog } from "./edit-branch-dialog";
import { RegenerateDialog } from "./regenerate-dialog";
import { SeedsBatchDialog } from "./seeds-batch-dialog";

afterEach(cleanup);

async function setup(options: Parameters<typeof mockClient>[0] = {}) {
  const client = mockClient(options);
  const line = await client.getLine(NAS_ROOT_ID);
  const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
  const chat = messages.filter((message) => message.kind === "chat" && message.role !== "system");
  return { client, line, messages, chat, wrapper: tangentWrapper(client) };
}

const userAt = (chat: readonly Message[], n: number) => chat.filter((message) => message.role === "user")[n]!;
const replyAt = (chat: readonly Message[], n: number) => chat.filter((message) => message.role === "assistant")[n]!;

describe("EditBranchDialog (S6)", () => {
  it("forks from the message before, prefills, and sends the edited text in the new branch", async () => {
    const { client, line, messages, chat, wrapper } = await setup();
    const own = userAt(chat, 1);
    const create = vi.spyOn(client, "createBranch");
    const send = vi.spyOn(client, "sendMessage");
    const onDone = vi.fn();
    render(<EditBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} messageId={own.id} onDone={onDone} />, { wrapper });
    const box = await screen.findByRole("textbox", { name: "Change it to" });
    await waitFor(() => expect(box).toHaveFocus());
    const submit = screen.getByRole("button", { name: "Branch and send" });
    expect(submit).toHaveAttribute("aria-disabled", "true");
    await userEvent.clear(box);
    await userEvent.type(box, "Btrfs instead?");
    expect(screen.getByRole("textbox", { name: "Branch purpose" })).toHaveValue("Asked again: Btrfs instead?");
    await userEvent.click(submit);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const before = chat[chat.indexOf(own) - 1]!;
    expect(create).toHaveBeenCalledWith(NAS_ROOT_ID, { anchorMessageId: before.id, purpose: "Asked again: Btrfs instead?", kind: "alternative" });
    const created = onDone.mock.calls[0]![0] as string;
    expect(send).toHaveBeenCalledWith(created, { content: "Btrfs instead?" });
    client.mock.dispose();
  });

  it("keeps the dialog and says why when the branch is refused", async () => {
    const { client, line, messages, chat, wrapper } = await setup();
    vi.spyOn(client, "createBranch").mockRejectedValue(new TangentError(409, "too many open branches", "branch_limit", { limit: 5 }));
    render(<EditBranchDialog open onOpenChange={() => undefined} line={line} messages={messages} messageId={userAt(chat, 1).id} onDone={vi.fn()} />, { wrapper });
    const box = await screen.findByRole("textbox", { name: "Change it to" });
    await userEvent.type(box, " again");
    await userEvent.click(screen.getByRole("button", { name: "Branch and send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^The branch was not opened:/);
    expect(box).toHaveValue(`${userAt(chat, 1).content} again`);
    client.mock.dispose();
  });
});

describe("RegenerateDialog (S7)", () => {
  it("marks the reply's model without picking it; the purpose follows the model; the question is re-sent from before it", async () => {
    const { client, line, messages, chat, wrapper } = await setup();
    const reply = replyAt(chat, 2);
    const send = vi.spyOn(client, "sendMessage");
    const create = vi.spyOn(client, "createBranch");
    const onDone = vi.fn();
    render(<RegenerateDialog open onOpenChange={() => undefined} line={line} messages={messages} replyId={reply.id} onDone={onDone} />, { wrapper });
    const group = await screen.findByRole("radiogroup", { name: "Model" });
    expect(within(group).getAllByRole("radio").filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Branch and re-ask" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await within(group).findByRole("radio", { name: /claude-haiku-4-5/ }));
    const purpose = screen.getByRole("textbox", { name: "Branch purpose" });
    expect((purpose as HTMLTextAreaElement).value).toMatch(/^Re-asked \(claude-haiku-4-5\): /);
    await userEvent.click(screen.getByRole("button", { name: "Branch and re-ask" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const question = chat[chat.indexOf(reply) - 1]!;
    expect(create.mock.calls[0]![1]).toMatchObject({ anchorMessageId: chat[chat.indexOf(question) - 1]!.id, kind: "alternative", provider: "anthropic", model: "claude-haiku-4-5" });
    expect(send).toHaveBeenCalledWith(onDone.mock.calls[0]![0], { content: question.content });
    client.mock.dispose();
  });

  it("offers a new conversation when the question opened the line", async () => {
    const { client, line, messages, chat, wrapper } = await setup();
    const onAskAgain = vi.fn();
    render(<RegenerateDialog open onOpenChange={() => undefined} line={line} messages={messages} replyId={replyAt(chat, 0).id} onDone={vi.fn()} onAskAgain={onAskAgain} />, { wrapper });
    expect(await screen.findByText(/opened this line, so there is nothing to branch from/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ask differently in a new conversation…" }));
    expect(onAskAgain).toHaveBeenCalledWith(expect.objectContaining({ id: userAt(chat, 0).id }));
    client.mock.dispose();
  });
});

describe("SeedsBatchDialog (S11, decision #14)", () => {
  const list = (n: number) => ({ id: "reply-list", seq: 999, lineId: NAS_ROOT_ID, role: "assistant", kind: "chat", status: "done", content: Array.from({ length: n }, (_, i) => `- item ${i + 1}`).join("\n"), meta: {}, hostMeta: {}, createdAt: "", pinned: false }) as Message;

  it("ticks only as many as fit, refuses more, and parks the ticked texts as edited", async () => {
    const { client, wrapper } = await setup();
    const open = (await client.listSeeds(NAS_ROOT_ID)).seeds.length;
    vi.spyOn(client, "listSeeds").mockResolvedValue({ rootLineId: NAS_ROOT_ID, seeds: (await client.listSeeds(NAS_ROOT_ID)).seeds, limits: { maxOpen: open + 2, maxRunes: 500 } });
    const batch = vi.spyOn(client, "createSeedsBatch").mockResolvedValue({ rootLineId: NAS_ROOT_ID, seeds: [] });
    const onDone = vi.fn();
    render(<SeedsBatchDialog open onOpenChange={() => undefined} rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} message={list(3)} onDone={onDone} />, { wrapper });
    const boxes = await screen.findAllByRole("checkbox", { name: /^Park item \d$/ });
    expect(boxes.map((box) => (box as HTMLInputElement).checked)).toEqual([true, true, false]);
    expect(screen.getByRole("status")).toHaveTextContent(`Parking has ${open} of ${open + 2}; 0 spots left after saving 2.`);
    await userEvent.click(boxes[2]!);
    expect(screen.getByRole("alert")).toHaveTextContent("Parking has only 2 spots left and 3 are ticked.");
    expect(screen.getByRole("button", { name: "Park 3" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(boxes[0]!);
    const second = screen.getByRole("textbox", { name: "Item 2" });
    await userEvent.clear(second);
    await userEvent.type(second, "edited item");
    await userEvent.click(screen.getByRole("button", { name: "Park 2" }));
    await waitFor(() => expect(batch).toHaveBeenCalledWith(NAS_ROOT_ID, { anchorMessageId: "reply-list", texts: ["edited item", "item 3"] }));
    client.mock.dispose();
  });

  it("lists at most 20 and says so", async () => {
    const { client, wrapper } = await setup();
    render(<SeedsBatchDialog open onOpenChange={() => undefined} rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} message={list(23)} onDone={vi.fn()} />, { wrapper });
    expect(await screen.findAllByRole("textbox", { name: /^Item \d+$/ })).toHaveLength(20);
    expect(screen.getByText("Only the first 20 items are listed (one batch takes at most 20).")).toBeInTheDocument();
    client.mock.dispose();
  });
});

describe("DivergeDialog: 跨模型平行比較 (S8)", () => {
  it("switches mode, needs 2 to 5 models, writes each branch's purpose with its model, and opens them all", async () => {
    window.localStorage.removeItem("tangent:diverge-mode:v1");
    const { client, messages, chat, wrapper } = await setup();
    const reply = replyAt(chat, 2);
    const models = vi.spyOn(client, "divergeModels");
    const send = vi.spyOn(client, "sendMessage");
    const onOpenChange = vi.fn();
    render(<DivergeDialog open onOpenChange={onOpenChange} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} anchor={reply} messages={messages} />, { wrapper });
    await userEvent.click(await screen.findByRole("radio", { name: "Compare models side by side" }));
    const question = chat[chat.indexOf(reply) - 1]!;
    expect(await screen.findByRole("textbox", { name: "Question" })).toHaveValue(question.content);
    const open = screen.getByRole("button", { name: "Open 0 branches" });
    expect(open).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("checkbox", { name: /claude-haiku-4-5/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /claude-sonnet-4-5/ }));
    await userEvent.click(screen.getByRole("button", { name: "Open 2 branches" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const input = models.mock.calls[0]![1];
    // The unchanged question forks from before it and is sent in each branch.
    expect(input.anchorMessageId).toBe(chat[chat.indexOf(question) - 1]!.id);
    expect(input.targets.map((target) => target.purpose)).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"].map((model) => divergeTargetPurpose(purposeHead(question.content, 40), model)));
    expect(send).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("tangent:diverge-mode:v1")).toBe("models");
    client.mock.dispose();
  });

  it("says why the models side is off with fewer than two allowed models", async () => {
    window.localStorage.removeItem("tangent:diverge-mode:v1");
    const scenario = nasScenario();
    scenario.capabilities = { ...scenario.capabilities, models: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }] };
    const { client, messages, chat, wrapper } = await setup({ scenario });
    render(<DivergeDialog open onOpenChange={() => undefined} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} anchor={replyAt(chat, 2)} messages={messages} />, { wrapper });
    expect(await screen.findByRole("radio", { name: "Compare models side by side" })).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByText(/this workspace allows 1\./)).toBeInTheDocument();
    client.mock.dispose();
  });

  it("says which model the server refused; none opened", async () => {
    window.localStorage.setItem("tangent:diverge-mode:v1", "models");
    const { client, messages, chat, wrapper } = await setup();
    vi.spyOn(client, "divergeModels").mockRejectedValue(new TangentError(422, "not allowed", "model_not_allowed", { provider: "anthropic", model: "claude-sonnet-4-5" }));
    render(<DivergeDialog open onOpenChange={() => undefined} lineId={NAS_ROOT_ID} rootLineId={NAS_ROOT_ID} anchor={replyAt(chat, 2)} messages={messages} />, { wrapper });
    await userEvent.click(await screen.findByRole("checkbox", { name: /claude-haiku-4-5/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /claude-sonnet-4-5/ }));
    await userEvent.click(screen.getByRole("button", { name: "Open 2 branches" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No branches opened: claude-sonnet-4-5 is not allowed here.");
    client.mock.dispose();
  });
});
