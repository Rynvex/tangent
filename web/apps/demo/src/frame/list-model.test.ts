import { normalizeLine } from "@tangent/client";
import { describe, expect, it } from "vitest";
import { daysAgo, groupLines, isWaiting, matchesSearch, timeLabel } from "./list-model";

const TZ = "Asia/Taipei";
// 2026-10-15 21:00 in Taipei.
const NOW = new Date("2026-10-15T13:00:00Z");
const line = (id: string, lastActivityAt: string, over: Record<string, unknown> = {}) => normalizeLine({ id, title: id, lastActivityAt, ...over });

describe("conversation list model", () => {
  it("counts calendar days in the viewer's time zone", () => {
    expect(daysAgo("2026-10-15T00:30:00+08:00", NOW, TZ)).toBe(0);
    expect(daysAgo("2026-10-14T23:59:00+08:00", NOW, TZ)).toBe(1);
    expect(daysAgo("bad", NOW, TZ)).toBeNull();
  });

  it("groups by today, yesterday, this week and earlier, newest first, skipping empty groups", () => {
    const groups = groupLines(
      [line("old", "2026-09-01T10:00:00+08:00"), line("t2", "2026-10-15T09:00:00+08:00"), line("t1", "2026-10-15T20:00:00+08:00"), line("wk", "2026-10-12T10:00:00+08:00")],
      NOW,
      TZ,
    );
    expect(groups.map((group) => [group.key, group.lines.map((l) => l.id)])).toEqual([
      ["today", ["t1", "t2"]],
      ["week", ["wk"]],
      ["earlier", ["old"]],
    ]);
  });

  it("labels times like the prototype: clock today, weekday this week, date before", () => {
    expect(timeLabel("2026-10-15T20:42:00+08:00", NOW, "zh-TW", TZ)).toBe("20:42");
    expect(timeLabel("2026-10-13T20:42:00+08:00", NOW, "zh-TW", TZ)).toBe("週二");
    expect(timeLabel("2026-09-02T20:42:00+08:00", NOW, "zh-TW", TZ)).toBe("9/2");
  });

  it("searches title and topic, every word, ignoring case", () => {
    const nas = line("nas", "", { title: "家用 NAS 與備份策略", summary: { topic: "ZFS mirror" } });
    expect(matchesSearch(nas, "zfs")).toBe(true);
    expect(matchesSearch(nas, "nas 備份")).toBe(true);
    expect(matchesSearch(nas, "nas rust")).toBe(false);
  });

  it("waits for you on unread replies or a ready card draft", () => {
    expect(isWaiting(line("a", ""))).toBe(false);
    expect(isWaiting(line("a", "", { branchUnread: 1 }))).toBe(true);
    expect(isWaiting(line("a", "", { awaitingReview: 1 }))).toBe(true);
  });
});
