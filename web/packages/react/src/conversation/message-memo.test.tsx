import { normalizeMessage, type Message } from "@tangent/client";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadMarkdownRenderer } from "../markdown";
import { mockClient, tangentWrapper } from "../test-utils";
import { messageActionModel } from "./message-actions";
import { MessageList } from "./message-list";
import { MessageSheet } from "./message-menu";

beforeAll(() => loadMarkdownRenderer());
afterEach(cleanup);

const msg = (id: string, seq: number, over: Record<string, unknown>): Message => normalizeMessage({ id, seq, lineId: "l1", status: "done", ...over });
const MESSAGES = [msg("u1", 1, { role: "user", content: "My question" }), msg("a1", 2, { role: "assistant", content: "The answer" })];

/** The toolbars render their buttons once their message is pointed at (F8 S1): point at every one. */
const armToolbars = () =>
  act(() => {
    for (const bar of document.querySelectorAll("[data-tg-actions]")) bar.parentElement?.dispatchEvent(new Event("pointerenter"));
  });
const rowOf = (text: string) => screen.getByText(text).closest("[data-message-id]") as HTMLElement;
const moreOf = (row: HTMLElement) => within(row).queryAllByRole("button", { name: "More actions" }).find((button) => button.getAttribute("aria-haspopup") === "menu");

describe("記成備忘 in a message's menu (F10)", () => {
  it("sits after 記進紀要 on a reply and leads the user's own message's menu, only when wired", () => {
    const reply = messageActionModel({ text: "x", onBranch: vi.fn(), onNote: vi.fn(), onMemo: vi.fn(), onRelate: vi.fn() });
    expect(reply.groups.map((group) => group.map((item) => item.id))).toEqual([["note", "memo", "relate"]]);
    const mine = messageActionModel({ text: "x", role: "user", onEditBranch: vi.fn(), onMemo: vi.fn(), onMove: vi.fn() });
    expect(mine.groups.map((group) => group.map((item) => item.id))).toEqual([["memo", "move"]]);
    expect(messageActionModel({ text: "x", onBranch: vi.fn(), onNote: vi.fn() }).groups.flat().some((item) => item.id === "memo")).toBe(false);
  });

  it("hands the host the message, from a reply's and the user's own menu", async () => {
    const client = mockClient();
    const onMemo = vi.fn();
    render(<MessageList lineId="l1" messages={MESSAGES} onBranch={vi.fn()} onMemo={onMemo} />, { wrapper: tangentWrapper(client) });
    armToolbars();
    await userEvent.click(moreOf(rowOf("The answer"))!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Save as a memo" }));
    expect(onMemo).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a1", content: "The answer" }));
    await userEvent.click(moreOf(rowOf("My question"))!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Save as a memo" }));
    expect(onMemo).toHaveBeenLastCalledWith(expect.objectContaining({ id: "u1" }));
    client.mock.dispose();
  });

  it("is not offered to a viewer", () => {
    const client = mockClient();
    render(<MessageList lineId="l1" messages={MESSAGES} readOnly onMemo={vi.fn()} />, { wrapper: tangentWrapper(client) });
    armToolbars();
    expect(moreOf(rowOf("The answer"))).toBeUndefined();
    client.mock.dispose();
  });

  it("is a row of the touch sheet, which closes before saving", async () => {
    const client = mockClient();
    const onMemo = vi.fn();
    const onClose = vi.fn();
    render(<MessageSheet model={messageActionModel({ text: "The answer", who: "AI・#2", onBranch: vi.fn(), onMemo })} onClose={onClose} />, { wrapper: tangentWrapper(client) });
    await userEvent.click(await screen.findByRole("button", { name: "Save as a memo" }));
    expect(onClose).toHaveBeenCalled();
    expect(onMemo).toHaveBeenCalledTimes(1);
    client.mock.dispose();
  });
});

describe("存進名詞表 in a message's menu (F19 §2.1)", () => {
  it("sits right after 記成備忘 on both roles' menus, only when wired", () => {
    const reply = messageActionModel({ text: "x", onBranch: vi.fn(), onNote: vi.fn(), onMemo: vi.fn(), onTerm: vi.fn(), onRelate: vi.fn() });
    expect(reply.groups.map((group) => group.map((item) => item.id))).toEqual([["note", "memo", "term", "relate"]]);
    const mine = messageActionModel({ text: "x", role: "user", onEditBranch: vi.fn(), onMemo: vi.fn(), onTerm: vi.fn(), onMove: vi.fn() });
    expect(mine.groups.map((group) => group.map((item) => item.id))).toEqual([["memo", "term", "move"]]);
    expect(messageActionModel({ text: "x", onBranch: vi.fn(), onNote: vi.fn(), onMemo: vi.fn() }).groups.flat().some((item) => item.id === "term")).toBe(false);
  });

  it("hands the host the finished message", async () => {
    const client = mockClient();
    const onTerm = vi.fn();
    render(<MessageList lineId="l1" messages={MESSAGES} onBranch={vi.fn()} onTerm={onTerm} />, { wrapper: tangentWrapper(client) });
    armToolbars();
    await userEvent.click(moreOf(rowOf("The answer"))!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Save to glossary" }));
    expect(onTerm).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a1", content: "The answer" }));
    client.mock.dispose();
  });
});
