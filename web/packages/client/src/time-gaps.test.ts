import { describe, expect, it } from "vitest";
import { clockTime, shortDateUnlessToday, timeGaps } from "./time-gaps";
import type { Message } from "./types";

const message = (id: string, createdAt: string, extra: Partial<Message> = {}) => ({ id, createdAt, kind: "chat", role: "user", status: "done", ...extra }) as Message;
const local = (d: number, h: number, m: number) => new Date(2026, 7, d, h, m).toISOString();

describe("timeGaps", () => {
  it("marks a conversation message 30 minutes or more after the one before, skipping cards and pending replies", () => {
    // Arrange
    const list = [
      message("m1", local(12, 14, 52)),
      message("m2", local(12, 14, 58), { role: "assistant" }),
      message("card", local(12, 16, 0), { kind: "branch_card", role: "system" }),
      message("m3", local(12, 17, 35)),
      message("m4", local(12, 18, 4), { role: "assistant" }),
      message("m5", local(12, 18, 34)),
      message("p", local(12, 23, 0), { role: "assistant", status: "pending" }),
    ];
    // Act / Assert
    expect([...timeGaps(list).entries()]).toEqual([
      ["m3", (2 * 60 + 37) * 60_000],
      ["m5", 30 * 60_000],
    ]);
  });
});

describe("dates for the chapter strip and the gap divider", () => {
  it("shows MM/DD for another day and nothing for today", () => {
    const now = new Date(2026, 10, 3, 9, 0);
    expect(shortDateUnlessToday(local(12, 14, 20), now)).toBe("08/12");
    expect(shortDateUnlessToday(new Date(2026, 10, 3, 1, 0).toISOString(), now)).toBe("");
    expect(shortDateUnlessToday("", now)).toBe("");
    expect(clockTime(local(12, 17, 35))).toBe("17:35");
    expect(clockTime("nope")).toBe("");
  });
});
