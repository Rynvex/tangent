import { describe, expect, it } from "vitest";
import { message } from "./test-helpers";
import { firstUnreadId } from "./unread";

const LIST = [
  message("u1", "user", { seq: 1 }),
  message("a1", "assistant", { seq: 2 }),
  message("u2", "user", { seq: 3 }),
  message("a2", "assistant", { seq: 4 }),
  message("a3", "assistant", { seq: 5 }),
  message("c1", "assistant", { seq: 6, kind: "branch_card" }),
];

describe("firstUnreadId", () => {
  it("is the oldest of the last `unread` finished replies (a line counts one unread per reply)", () => {
    expect(firstUnreadId(LIST, 2)).toBe("a2");
    expect(firstUnreadId(LIST, 1)).toBe("a3");
    expect(firstUnreadId(LIST, 3)).toBe("a1");
  });

  it("is null with nothing unread, and the first reply when more are unread than there are replies", () => {
    expect(firstUnreadId(LIST, 0)).toBeNull();
    expect(firstUnreadId(LIST, 9)).toBe("a1");
    expect(firstUnreadId([], 2)).toBeNull();
  });

  it("follows seq, not the given order, and skips pending and failed replies", () => {
    const shuffled = [LIST[4]!, LIST[0]!, LIST[3]!, message("p", "assistant", { seq: 7, status: "pending" }), message("e", "assistant", { seq: 8, status: "error" })];
    expect(firstUnreadId(shuffled, 2)).toBe("a2");
  });
});
