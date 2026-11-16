import { describe, expect, it } from "vitest";
import { chapterRange, chapterTitle, chaptersByStart, describeChapterError, milestoneOn, normalizeChapters } from "./chapters";
import { TangentError } from "./errors";
import { echoT as t } from "./test-helpers";

const failure = (status: number, code = "") => new TangentError(status, "server text", code);

describe("normalizeChapters", () => {
  it("fills every missing field with a default", () => {
    const view = normalizeChapters({ chapters: [{ startMessageId: "m1" } as never], milestones: [{ id: "x" } as never] });
    expect(view.chapters[0]).toMatchObject({ index: 0, titleSource: "time", kind: "start", branchIds: [], cardMessageIds: [], messageCount: 0 });
    expect(view.milestones[0]).toMatchObject({ id: "x", messageId: "", title: "" });
    expect(view.limits).toEqual({ maxChapters: 60, minMessages: 3, idleGapMinutes: 30, maxMilestones: 200, milestoneMaxLen: 80 });
  });

  it("copes with a missing body", () => {
    expect(normalizeChapters(null).chapters).toEqual([]);
  });

  it("drops unknown kinds and non-string ids", () => {
    const view = normalizeChapters({ chapters: [{ kind: "odd", titleSource: "odd", branchIds: ["a", 3] } as never] });
    expect(view.chapters[0]).toMatchObject({ kind: "start", titleSource: "time", branchIds: ["a"] });
  });
});

describe("chapter labels", () => {
  const base = normalizeChapters({ chapters: [{ title: "Cache design", titleSource: "topic", startAt: "2026-10-14T09:01:00Z", endAt: "2026-10-14T10:30:00Z" } as never] }).chapters[0]!;

  it("shows a named chapter's own title", () => {
    expect(chapterTitle(base, "en")).toBe("Cache design");
  });

  it("formats the start time when the title only came from the time", () => {
    const timed = { ...base, titleSource: "time" as const, title: "2026-10-14 09:01" };
    expect(chapterTitle(timed, "en")).toMatch(/2026/);
  });

  it("gives the range on one line and adds a date when it spans days", () => {
    expect(chapterRange(base, "en")).toContain(" - ");
    const longer = { ...base, endAt: "2026-10-15T10:30:00Z" };
    expect(chapterRange(longer, "en").split(" - ")[1]).toMatch(/15/);
  });
});

describe("lookups", () => {
  it("indexes chapters by first message and finds a milestone by message", () => {
    const view = normalizeChapters({
      chapters: [{ index: 0, startMessageId: "m1" } as never, { index: 1, startMessageId: "m5" } as never],
      milestones: [{ id: "ms", messageId: "m5" } as never],
    });
    expect(chaptersByStart(view.chapters).get("m5")?.index).toBe(1);
    expect(milestoneOn(view.milestones, "m5")?.id).toBe("ms");
    expect(milestoneOn(view.milestones, "m1")).toBeUndefined();
  });
});

describe("describeChapterError", () => {
  it.each([
    ["message_not_found", "chapters.errorMessageNotFound"],
    ["milestone_not_found", "chapters.errorMilestoneNotFound"],
    ["milestone_exists", "chapters.errorExists"],
    ["archived", "chapters.errorArchived"],
  ] as const)("explains %s", (code, key) => {
    expect(describeChapterError(failure(409, code), t)).toBe(t(key));
  });

  it("quotes the limits from the contract, or the server's own", () => {
    expect(describeChapterError(failure(409, "milestone_limit"), t)).toBe(t("chapters.errorLimit", { max: 200 }));
    expect(describeChapterError(failure(422, "invalid_milestone"), t)).toBe(t("chapters.errorInvalid", { max: 80 }));
    const custom = new TangentError(409, "x", "milestone_limit", { maxMilestones: 5 });
    expect(describeChapterError(custom, t)).toBe(t("chapters.errorLimit", { max: 5 }));
  });

  it("says a viewer needs write access and falls back to the server text", () => {
    expect(describeChapterError(failure(403), t)).toBe(t("chapters.errorViewer"));
    expect(describeChapterError(failure(400), t)).toBe("server text");
    expect(describeChapterError(new Error("x"), t)).toBe(t("chapters.errorUnknown"));
  });
});

describe("chapter ranges in the display time zone (review LOW)", () => {
  // 15:00Z and 17:00Z are the same UTC day but 23:00 and 01:00 (next day) in Taipei.
  const chapter = normalizeChapters({ chapters: [{ startAt: "2026-10-14T15:00:00Z", endAt: "2026-10-14T17:00:00Z" }] }).chapters[0]!;

  it("adds the date to the end when it falls on another local day", () => {
    const end = chapterRange(chapter, "en-CA", "Asia/Taipei").split(" - ")[1]!;
    expect(end).toMatch(/2026-10-15/);
  });

  it("leaves the date off when both ends share the local day", () => {
    const end = chapterRange(chapter, "en-CA", "UTC").split(" - ")[1]!;
    expect(end).not.toMatch(/2026/);
  });
});

describe("host-defined chapter codes (DESIGN §12)", () => {
  it("use the host's text when it has one, else the server's", () => {
    const hostText = (code: string) => (code === "quota_exceeded" ? "host says no" : undefined);
    expect(describeChapterError(failure(409, "quota_exceeded"), t, { hostText })).toBe("host says no");
    expect(describeChapterError(failure(409, "other_host_code"), t, { hostText })).toBe("server text");
    expect(describeChapterError(failure(409, "milestone_exists"), t, { hostText: () => "never" })).toBe(t("chapters.errorExists"));
  });
});
