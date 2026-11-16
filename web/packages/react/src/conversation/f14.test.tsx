/** F14 S4 in the transcript: the dashed divider where a line paused, and the chapter strip with dates. */
import { chapterTitle, normalizeMessage, type Chapter, type Message } from "@tangent/client";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockClient, tangentWrapper } from "../test-utils";
import { ChapterStrip } from "./chapter-strip";
import { MessageList } from "./message-list";

afterEach(cleanup);

const local = (d: number, h: number, m: number) => new Date(2026, 7, d, h, m).toISOString();
const msg = (id: string, seq: number, role: string, createdAt: string): Message => normalizeMessage({ id, seq, lineId: "l1", status: "done", role, content: `${id} text`, createdAt });

describe("TimeGapDivider in the message list", () => {
  const messages = [msg("u1", 1, "user", local(12, 14, 52)), msg("a1", 2, "assistant", local(12, 14, 58)), msg("u2", 3, "user", local(12, 17, 35)), msg("a2", 4, "assistant", local(12, 17, 36))];

  it("draws “2 h 37 min gap · 17:35” before the message that came after the pause", () => {
    // Arrange / Act
    const client = mockClient();
    render(<MessageList lineId="l1" messages={messages} />, { wrapper: tangentWrapper(client) });
    // Assert
    const divider = screen.getByText("2 h 37 min gap · 17:35");
    expect(divider.closest("[data-message-id]")).toHaveAttribute("data-message-id", "u2");
    expect(document.querySelectorAll("[data-tg-time-gap]")).toHaveLength(1);
    client.mock.dispose();
  });

  it("draws none when the host turns them off", () => {
    const client = mockClient();
    render(<MessageList lineId="l1" messages={messages} timeGaps={false} />, { wrapper: tangentWrapper(client) });
    expect(document.querySelector("[data-tg-time-gap]")).toBeNull();
    client.mock.dispose();
  });
});

describe("ChapterStrip", () => {
  const chapter = (index: number, title: string, startAt: string): Chapter => ({
    index,
    title,
    titleSource: "milestone",
    kind: "milestone",
    milestoneId: `m${index}`,
    startMessageId: `s${index}`,
    endMessageId: `e${index}`,
    startAt,
    endAt: startAt,
    messageCount: 4,
    branchIds: [],
    cardMessageIds: [],
  });

  it("lists §n, the title and the date of a chapter from another day, and scrolls to the one pressed", async () => {
    // Arrange
    const box = document.createElement("div");
    const divider = document.createElement("div");
    divider.setAttribute("data-tg-chapter", "1");
    divider.scrollIntoView = vi.fn();
    box.append(divider);
    document.body.append(box);
    const client = mockClient();
    const chapters = [chapter(0, "PG 連線池設定", local(12, 14, 20)), chapter(1, "高併發壓測與鎖等待", local(15, 10, 5))];
    // Act
    render(<ChapterStrip chapters={chapters} scroller={() => box} />, { wrapper: tangentWrapper(client) });
    const second = screen.getByRole("button", { name: "§2 高併發壓測與鎖等待 08/15" });
    await userEvent.click(second);
    // Assert
    expect(screen.getByRole("navigation", { name: "Main line chapters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "§1 PG 連線池設定 08/12" })).not.toHaveAttribute("aria-current");
    expect(second).toHaveAttribute("aria-current", "location");
    expect(divider.scrollIntoView).toHaveBeenCalled();
    box.remove();
    client.mock.dispose();
  });

  it("shows the date once for a chapter titled by its time (an idle chapter of an imported history)", () => {
    // Arrange
    const client = mockClient();
    const idle: Chapter = { ...chapter(1, "", local(12, 17, 35)), kind: "idle", titleSource: "time", milestoneId: "" };
    const timeTitled = chapterTitle(idle, "en");
    // Act
    render(<ChapterStrip chapters={[chapter(0, "PG 連線池設定", local(12, 14, 20)), idle]} scroller={() => null} />, { wrapper: tangentWrapper(client) });
    // Assert
    expect(screen.getByRole("button", { name: "§1 PG 連線池設定 08/12" })).toBeInTheDocument();
    const second = screen.getByRole("button", { name: `§2 ${timeTitled}` });
    expect(second.textContent).toBe(`§2${timeTitled}`);
    expect(second.textContent?.match(/08\/12/g) ?? []).toHaveLength(1);
    client.mock.dispose();
  });
});

describe("message times (F14 S4b)", () => {
  it("shows the clock after each label, with the day for another day, and keeps the labels the buttons use", () => {
    // Arrange
    const client = mockClient();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 52).toISOString();
    const messages = [msg("u1", 1, "user", local(12, 9, 5)), msg("a1", 2, "assistant", today)];
    // Act
    render(<MessageList lineId="l1" messages={messages} />, { wrapper: tangentWrapper(client) });
    // Assert
    const times = [...document.querySelectorAll("[data-tg-message-time]")];
    expect(times.map((time) => time.textContent)).toEqual([" · 08/12 09:05", " · 14:52"]);
    expect(times[0]).toHaveAttribute("datetime", messages[0]!.createdAt);
    expect(screen.getByText("You · #1")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "AI · #2" })).toBeInTheDocument();
    client.mock.dispose();
  });
});
