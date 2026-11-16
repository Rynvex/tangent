import { normalizeMessage, type Chapter, type Message } from "@tangent/client";
import { NAS_ROOT_ID } from "@tangent/client/testing";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessageList } from "../conversation/message-list";
import { loadMarkdownRenderer } from "../markdown";
import { mockClient, tangentWrapper } from "../test-utils";
import { ChapterList } from "./chapter-list";

beforeAll(() => loadMarkdownRenderer());
afterEach(cleanup);

const msg = (id: string, seq: number, role: "user" | "assistant"): Message => normalizeMessage({ id, seq, lineId: "l1", role, status: "done", content: `text ${id}` });
const MESSAGES = [msg("m1", 1, "user"), msg("m2", 2, "assistant"), msg("m3", 3, "user"), msg("m4", 4, "assistant")];
const chapter = (index: number, over: Partial<Chapter>): Chapter => ({
  index,
  title: "",
  titleSource: "topic",
  kind: "topic",
  milestoneId: "",
  startMessageId: "m1",
  endMessageId: "m2",
  startAt: "2026-10-12T13:40:00Z",
  endAt: "2026-10-12T14:15:00Z",
  messageCount: 2,
  branchIds: [],
  cardMessageIds: [],
  ...over,
});
const CHAPTERS = [
  chapter(0, { title: "Hardware", kind: "start" }),
  chapter(1, { title: "Backups", kind: "milestone", titleSource: "milestone", milestoneId: "ms1", startMessageId: "m3", endMessageId: "m4" }),
];

describe("chapter dividers in the transcript (A10)", () => {
  it("marks where each chapter starts, with its range of messages, time and source; a milestone can be removed", async () => {
    const client = mockClient();
    const onDeleteMilestone = vi.fn();
    render(<MessageList lineId="l1" messages={MESSAGES} chapters={CHAPTERS} onDeleteMilestone={onDeleteMilestone} />, { wrapper: tangentWrapper(client, undefined, { locale: "en" }) });
    const second = screen.getByRole("heading", { name: "Backups" }).closest("[data-tg-chapter]") as HTMLElement;
    expect(second).toHaveTextContent("#3–4");
    expect(second).toHaveTextContent("Milestone");
    expect(screen.getByRole("heading", { name: "Hardware" }).closest("[data-tg-chapter]")).toHaveTextContent("Start");
    await userEvent.click(within(second).getByRole("button", { name: "Remove the milestone “Backups”" }));
    expect(onDeleteMilestone).toHaveBeenCalledWith("ms1");
    client.mock.dispose();
  });

  it("shows no divider while a line has a single chapter", () => {
    const client = mockClient();
    render(<MessageList lineId="l1" messages={MESSAGES} chapters={[CHAPTERS[0]!]} />, { wrapper: tangentWrapper(client) });
    expect(screen.queryByRole("heading", { name: "Hardware" })).toBeNull();
    client.mock.dispose();
  });
});

describe("ChapterList (side panel, A10)", () => {
  it("jumps to a chapter and adds a milestone on the given message", async () => {
    const client = mockClient();
    const onJump = vi.fn();
    render(<ChapterList rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} messages={[]} anchorMessageId="nas-m26" onJump={onJump} />, { wrapper: tangentWrapper(client) });
    const list = await screen.findByRole("list", { name: "Chapters" });
    await userEvent.click(within(list).getByRole("button", { name: /^Hardware choice|硬體選擇/ }));
    expect(onJump).toHaveBeenCalledWith("nas-m16");
    await userEvent.type(screen.getByRole("textbox", { name: "Milestone name (optional)" }), "Decided ZFS");
    await userEvent.click(screen.getByRole("button", { name: "Add a milestone here" }));
    await waitFor(() => expect(within(list).getByRole("button", { name: /Decided ZFS/ })).toBeInTheDocument());
    client.mock.dispose();
  });

  it("offers no milestone form to a read-only identity", async () => {
    const client = mockClient();
    render(<ChapterList rootLineId={NAS_ROOT_ID} lineId={NAS_ROOT_ID} messages={[]} anchorMessageId="nas-m26" onJump={() => undefined} readOnly />, { wrapper: tangentWrapper(client) });
    await screen.findByRole("list", { name: "Chapters" });
    expect(screen.queryByRole("button", { name: "Add a milestone here" })).toBeNull();
    client.mock.dispose();
  });
});
