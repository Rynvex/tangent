/** F6 phase 1: the argument tag control (D2), the fold block and the fold dialog (D4). */
import { normalizeFold, type Message } from "@tangent/client";
import { NAS_ROOT_ID, nasScenario } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { ArgTag } from "./arg-tag";
import { FoldBlock } from "./fold-block";
import { FoldDialog } from "./fold-dialog";

afterEach(cleanup);
const clients: Array<{ mock: { dispose(): void } }> = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.mock.dispose();
});

function setup({ readOnly = false } = {}) {
  const scenario = nasScenario();
  if (readOnly) scenario.capabilities = { ...scenario.capabilities, permissions: { canWrite: false } };
  const client = mockClient({ scenario, draftMs: 5 });
  clients.push(client);
  return { client, wrapper: tangentWrapper(client, undefined, { locale: "zh-TW" }) };
}

const messageOf = async (client: ReturnType<typeof setup>["client"], id: string): Promise<Message> => (await client.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === id)!;

describe("ArgTag (D2; F8 S1: ArgBadge / ArgDraftActions)", () => {
  it("an untagged message shows nothing; a confirmed type is a solid badge without actions", async () => {
    const { client, wrapper } = setup();
    const { rerender, container } = render(<ArgTag rootLineId={NAS_ROOT_ID} message={await messageOf(client, "nas-m17")} who="AI・#2" />, { wrapper });
    await waitFor(() => expect(container.querySelector("[data-tg-arg-badge]")).toBeNull());
    const confirmed = { ...(await messageOf(client, "nas-m17")), tag: { kind: "decision" as const, source: "user" as const, status: "confirmed" as const, updatedAt: "" } };
    rerender(<ArgTag rootLineId={NAS_ROOT_ID} message={confirmed} who="AI・#2" />);
    const badge = await screen.findByText("決定");
    expect(badge.closest("[data-tg-arg-badge]")).toHaveAttribute("data-tg-arg-badge", "confirmed");
    expect(badge.closest("[data-tg-arg-badge]")!.className).not.toContain("border-dashed");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("AI's draft is dashed with 待確認; 確認 keeps it as the user's, 移除 clears it", async () => {
    const { client, wrapper } = setup();
    const draft = { ...(await messageOf(client, "nas-m17")), tag: { kind: "idea" as const, source: "ai" as const, status: "draft" as const, updatedAt: "" } };
    const { rerender } = render(<ArgTag rootLineId={NAS_ROOT_ID} message={draft} who="AI・#2" />, { wrapper });
    const badge = (await screen.findByText("想法")).closest("[data-tg-arg-badge]")!;
    expect(badge).toHaveAttribute("data-tg-arg-badge", "draft");
    expect(badge.className).toContain("border-dashed");
    expect(badge).toHaveTextContent("想法・待確認");
    expect(badge.closest("[data-tag-status]")).toHaveAttribute("data-tag-status", "draft");
    await userEvent.click(screen.getByRole("button", { name: "確認類型「想法」" }));
    await waitFor(async () => expect((await messageOf(client, "nas-m17")).tag).toMatchObject({ kind: "idea", source: "user", status: "confirmed" }));
    rerender(<ArgTag rootLineId={NAS_ROOT_ID} message={draft} who="AI・#2" />);
    await userEvent.click(screen.getByRole("button", { name: "移除類型 (AI・#2)" }));
    await waitFor(async () => expect((await messageOf(client, "nas-m17")).tag).toBeUndefined());
  });

  it("改類型… picks another kind from a menu", async () => {
    const { client, wrapper } = setup();
    const draft = { ...(await messageOf(client, "nas-m17")), tag: { kind: "idea" as const, source: "ai" as const, status: "draft" as const, updatedAt: "" } };
    render(<ArgTag rootLineId={NAS_ROOT_ID} message={draft} who="AI・#2" />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "改類型… (AI・#2)" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(["問題", "贊成", "反對", "決定"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "反對" }));
    await waitFor(async () => expect((await messageOf(client, "nas-m17")).tag).toMatchObject({ kind: "con", source: "user" }));
  });

  it("a viewer reads the type and changes nothing; an untagged message shows nothing", async () => {
    const { client, wrapper } = setup({ readOnly: true });
    const tagged = { ...(await messageOf(client, "nas-m17")), tag: { kind: "pro" as const, source: "ai" as const, status: "draft" as const, updatedAt: "" } };
    const { rerender } = render(<ArgTag rootLineId={NAS_ROOT_ID} message={tagged} who="AI・#2" />, { wrapper });
    expect(await screen.findByText("贊成")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    rerender(<ArgTag rootLineId={NAS_ROOT_ID} message={await messageOf(client, "nas-m17")} who="AI・#2" />);
    expect(screen.queryByText(/類型|贊成/)).toBeNull();
  });
});

const fold = (over: Record<string, unknown> = {}) =>
  normalizeFold({ id: "f1", lineId: NAS_ROOT_ID, fromSeq: 16, toSeq: 19, messageCount: 4, tokensOriginal: 4200, tokensSummary: 180, status: "active", summary: "比較了配法，決定用 mirror。", aiDrafted: true, ...over });

describe("FoldBlock (D4, components.md: collapsed, the original shown)", () => {
  it("collapsed: the range, the tokens saved and the summary; the original only once expanded", async () => {
    const { wrapper } = setup();
    render(
      <FoldBlock lineId={NAS_ROOT_ID} fold={fold()} range={{ from: 1, to: 4 }}>
        <p>原文的一則</p>
      </FoldBlock>,
      { wrapper },
    );
    const toggle = await screen.findByRole("button", { name: /^已折疊 #1–#4/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("送給 AI 時只送摘要：180 token（原本 4.2k）")).toBeInTheDocument();
    expect(screen.getByText("摘要：比較了配法，決定用 mirror。")).toBeInTheDocument();
    expect(screen.queryByText("原文的一則")).toBeNull();
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("region", { name: "原文" })).getByText("原文的一則")).toBeInTheDocument();
  });

  it("drafting (no motion when reduced) and failed say so", async () => {
    const { wrapper } = setup();
    const { rerender } = render(<FoldBlock lineId={NAS_ROOT_ID} fold={fold({ status: "drafting", summary: "" })} range={{ from: 1, to: 4 }} />, { wrapper });
    const drafting = await screen.findByText("AI 正在寫摘要…");
    // The text never fades (contrast); only the spinner turns, and not when motion is reduced.
    expect(drafting.className).not.toMatch(/animate-/);
    const spinner = drafting.querySelector("[data-tg-working]")!;
    expect(spinner.getAttribute("class")).toContain("motion-safe:animate-");
    expect(spinner.getAttribute("class")).not.toMatch(/(^| )animate-/);
    rerender(<FoldBlock lineId={NAS_ROOT_ID} fold={fold({ status: "failed", summary: "" })} range={{ from: 1, to: 4 }} />);
    expect(screen.getByText("摘要沒寫成；取消折疊後可以再試一次。")).toBeInTheDocument();
  });

  it("取消折疊 removes it; a viewer has no such button", async () => {
    const { client, wrapper } = setup();
    const chat = (await client.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat");
    const made = await client.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[1]!.id, summary: "兩則" });
    render(<FoldBlock lineId={NAS_ROOT_ID} fold={made.fold} range={{ from: 1, to: 2 }} />, { wrapper });
    await userEvent.click(await screen.findByRole("button", { name: "取消折疊" }));
    await waitFor(async () => expect((await client.listFolds(NAS_ROOT_ID)).folds).toEqual([]));
    cleanup();
    const viewer = setup({ readOnly: true });
    render(<FoldBlock lineId={NAS_ROOT_ID} fold={fold()} range={{ from: 1, to: 4 }} />, { wrapper: viewer.wrapper });
    await screen.findByRole("button", { name: /^已折疊/ });
    await waitFor(() => expect(screen.queryByRole("button", { name: "取消折疊" })).toBeNull());
  });
});

describe("FoldDialog (折疊成摘要 from a message)", () => {
  it("folds from the message to the one chosen; empty summary means AI drafts it", async () => {
    const { client, wrapper } = setup();
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    const chat = messages.filter((message) => message.kind === "chat");
    const numbers = new Map(chat.map((message, index) => [message.id, index + 1]));
    const onOpenChange = vi.fn();
    render(<FoldDialog open onOpenChange={onOpenChange} lineId={NAS_ROOT_ID} start={chat[0]!} messages={messages} numbers={numbers} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "折疊成摘要" });
    const end = within(dialog).getByRole("combobox", { name: "折疊到" });
    expect(within(end).getAllByRole("option")[0]).toHaveTextContent(/^#2 AI：/);
    await userEvent.selectOptions(end, chat[2]!.id);
    await userEvent.click(within(dialog).getByRole("button", { name: "折疊" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect((await client.listFolds(NAS_ROOT_ID)).folds[0]).toMatchObject({ fromMessageId: chat[0]!.id, toMessageId: chat[2]!.id });
  });

  it("with a summary written it is used as is; no later message means nothing to fold", async () => {
    const { client, wrapper } = setup();
    const messages = (await client.listMessages(NAS_ROOT_ID)).messages;
    const chat = messages.filter((message) => message.kind === "chat");
    const numbers = new Map(chat.map((message, index) => [message.id, index + 1]));
    const { rerender } = render(<FoldDialog open onOpenChange={vi.fn()} lineId={NAS_ROOT_ID} start={chat[0]!} messages={messages} numbers={numbers} />, { wrapper });
    const dialog = await screen.findByRole("dialog", { name: "折疊成摘要" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "摘要（留白由 AI 起草）" }), "我自己的摘要");
    await userEvent.click(within(dialog).getByRole("button", { name: "折疊" }));
    await waitFor(async () => expect((await client.listFolds(NAS_ROOT_ID)).folds[0]).toMatchObject({ summary: "我自己的摘要", status: "active", aiDrafted: false }));
    rerender(<FoldDialog open onOpenChange={vi.fn()} lineId={NAS_ROOT_ID} start={chat.at(-1)!} messages={messages} numbers={numbers} />);
    expect(await screen.findByText("這則之後沒有可以一起折疊的訊息。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "折疊" })).toHaveAttribute("aria-disabled", "true");
  });
});
