import { describe, expect, it } from "vitest";
import { at, conversation, designSessions, messages, session, sessionA, sessionB, sessionC, sessionD } from "./import-fixtures";
import {
  allUntimed,
  buildMiniExpand,
  findDuplicate,
  findInterleaves,
  matchSession,
  moveSession,
  orderByTime,
  placeSession,
  selectionSummary,
  sessionEnding,
  sessionGist,
  sessionMessageTimes,
  sessionSourceId,
  sessionStartIso,
  sessionTimes,
} from "./import-timeline";
import { describeGap, SESSION_GAP_MS } from "./time-gaps";

const byKey = (list: ReturnType<typeof designSessions>) => new Map(list.map((item) => [item.key, item]));

describe("sessionTimes: which time a session is placed by", () => {
  it("takes the user's time first, then the source's createdAt, its first dated message, updatedAt and the file's time", () => {
    // Arrange
    const a = sessionA();
    const noCreated = session("X", conversation("x", "x", messages("x", [null, at(12, 9, 0), at(12, 9, 30)]), { createdAt: null, updatedAt: at(13, 0, 0) }), "chatgpt", 0);
    const onlyUpdated = session("Y", conversation("y", "y", messages("y", [null]), { createdAt: null, updatedAt: at(14, 0, 0), timeSource: "exact" }), "chatgpt", 0);
    // Act / Assert
    expect(sessionTimes(a)).toEqual({ kind: "exact", start: Date.parse(at(12, 14, 20)), end: Date.parse(at(12, 18, 2)) });
    expect(sessionTimes({ ...a, manualTime: at(13, 10, 0) })).toEqual({ kind: "manual", start: Date.parse(at(13, 10, 0)), end: Date.parse(at(13, 10, 0)) + (Date.parse(at(12, 18, 2)) - Date.parse(at(12, 14, 20))) });
    expect(sessionTimes(noCreated).start).toBe(Date.parse(at(12, 9, 0)));
    expect(sessionTimes(onlyUpdated)).toMatchObject({ kind: "exact", start: Date.parse(at(14, 0, 0)) });
    expect(sessionTimes(sessionD())).toEqual({ kind: "file", start: Date.parse(at(18, 9, 0)), end: Date.parse(at(18, 9, 0)) });
    expect(sessionTimes({ ...sessionD(), conversation: { ...sessionD().conversation, fileTime: null } })).toEqual({ kind: "none", start: null, end: null });
  });

  it("shifts every dated message by the user's time, and dates the first of an undated session with it", () => {
    const shifted = sessionMessageTimes({ ...sessionB(), manualTime: at(13, 15, 10) });
    expect(shifted.get("b1")).toBe(at(13, 15, 10));
    expect(shifted.get("b4")).toBe(at(13, 15, 22));
    const undated = sessionMessageTimes({ ...sessionD(), manualTime: at(16, 20, 30) });
    expect([...undated.entries()]).toEqual([["d1", at(16, 20, 30)]]);
    expect(sessionMessageTimes(sessionD()).size).toBe(0);
    expect(sessionStartIso(sessionD())).toBeNull();
    expect(sessionStartIso({ ...sessionD(), manualTime: at(16, 20, 30) })).toBe(at(16, 20, 30));
  });
});

describe("orderByTime", () => {
  it("puts the oldest first and the file-dated by their file time (decision #4)", () => {
    // Arrange: checked newest first, as the picker lists them.
    const list = designSessions().reverse().map((item, index) => ({ ...item, pickOrder: index }));
    // Act / Assert
    expect(orderByTime(list)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("places sessions without any time after the dated ones, in the order they were checked", () => {
    const pasted = (key: string, pickOrder: number) => session(key, conversation(key, key, messages(key, [null])), "text", pickOrder);
    const list = [pasted("P2", 1), sessionC(), pasted("P1", 0), sessionA()];
    expect(orderByTime(list)).toEqual(["A", "C", "P1", "P2"]);
    expect(allUntimed([pasted("P1", 0), pasted("P2", 1)])).toBe(true);
    expect(allUntimed(list)).toBe(false);
  });

  it("re-sorts after a time is set, keeping what was dragged among equal times", () => {
    const list = designSessions();
    const moved = list.map((item) => (item.key === "D" ? { ...item, manualTime: at(16, 20, 30) } : item));
    expect(orderByTime(moved)).toEqual(["A", "B", "C", "D", "E"]);
    const tied = [session("P", conversation("p", "p", messages("p", [at(1, 0, 0)])), "chatgpt", 0), session("Q", conversation("q", "q", messages("q", [at(1, 0, 0)])), "chatgpt", 1)];
    expect(orderByTime(tied)).toEqual(["P", "Q"]);
    expect(orderByTime(tied, ["Q", "P"])).toEqual(["Q", "P"]);
  });

  it("moves a session by keyboard or menu, clamped at the ends, and places a dropped one", () => {
    const order = ["A", "B", "C", "D"];
    expect(moveSession(order, "C", -1)).toEqual(["A", "C", "B", "D"]);
    expect(moveSession(order, "A", -1)).toEqual(order);
    expect(moveSession(order, "D", 5)).toEqual(order);
    expect(moveSession(order, "Z", 1)).toEqual(order);
    expect(placeSession(order, "A", 2)).toEqual(["B", "C", "A", "D"]);
    expect(order).toEqual(["A", "B", "C", "D"]);
  });
});

describe("findInterleaves (decision #1)", () => {
  it("finds B starting while A is still going, and nothing else in the design's five", () => {
    const list = designSessions();
    expect(findInterleaves(["A", "B", "C", "D", "E"], byKey(list))).toEqual([{ inner: "B", outer: "A", at: Date.parse(at(12, 15, 10)) }]);
  });

  it("does not count a session that starts exactly when the other ends, or one without any time", () => {
    const a = session("A", conversation("a", "a", messages("a", [at(1, 10, 0), at(1, 11, 0)])), "chatgpt", 0);
    const b = session("B", conversation("b", "b", messages("b", [at(1, 11, 0)])), "chatgpt", 1);
    const d = { ...sessionD(), conversation: { ...sessionD().conversation, fileTime: null } };
    expect(findInterleaves(["A", "B", "D"], new Map([a, b, d].map((item) => [item.key, item])))).toEqual([]);
  });
});

describe("buildMiniExpand", () => {
  it("cuts a session at pauses of 30 minutes or more, with turns, a first line, the regenerations and the ending", () => {
    // Act
    const mini = buildMiniExpand(sessionA().conversation);
    // Assert
    expect(mini.segments.map((segment) => [segment.from, segment.to, segment.turns, segment.gapBeforeMs])).toEqual([
      [1, 4, 2, null],
      [5, 12, 4, (2 * 60 + 37) * 60_000],
    ]);
    expect(mini.segments[0]!.summary).toBe("PgBouncer 要用哪種 pool mode？");
    expect(mini.segments[1]).toMatchObject({ start: at(12, 17, 35), end: at(12, 18, 2), regenerations: 1 });
    expect(mini.breaks).toBe(1);
    expect(mini.regenerations).toBe(1);
    expect(mini.ending).toBe("default_pool_size 20、transaction mode。");
    expect(mini.messageCount).toBe(12);
  });

  it("splits at exactly 30 minutes, not at 29, and keeps undated messages in the stretch they are in", () => {
    const list = messages("m", [at(1, 10, 0), at(1, 10, 29), null, at(1, 10, 58), at(1, 11, 28)]);
    const mini = buildMiniExpand(conversation("m", "m", list));
    expect(mini.segments.map((segment) => [segment.from, segment.to])).toEqual([[1, 4], [5, 5]]);
    expect(mini.segments[1]!.gapBeforeMs).toBe(SESSION_GAP_MS);
  });

  it("is one stretch without times, and leaves removed messages out of the count and the ending", () => {
    const mini = buildMiniExpand(sessionD().conversation, new Set(["d12"]));
    expect(mini.segments).toHaveLength(1);
    expect(mini.breaks).toBe(0);
    expect(mini.messageCount).toBe(11);
    expect(mini.ending).toBe("D 第 10 則。");
  });

  it("ends with the last message when there is no reply, and sums up the first exchange", () => {
    expect(sessionEnding([{ role: "user", content: "只有提問。後面還有。" }])).toBe("只有提問。");
    expect(sessionEnding([])).toBe("");
    expect(sessionGist(sessionA().conversation)).toEqual({ question: "PgBouncer 要用哪種 pool mode？", answer: "A 第 2 則。" });
  });
});

describe("describeGap", () => {
  it("names the two largest parts in Chinese and English", () => {
    expect(describeGap((2 * 60 + 37) * 60_000, "zh-TW")).toBe("2 小時 37 分");
    expect(describeGap(41 * 60_000, "zh-TW")).toBe("41 分");
    expect(describeGap(2 * 3600_000, "zh-TW")).toBe("2 小時");
    expect(describeGap((3 * 24 + 2) * 3600_000 + 5 * 60_000, "zh-TW")).toBe("3 天 2 小時");
    expect(describeGap((2 * 60 + 37) * 60_000, "en")).toBe("2 h 37 min");
    expect(describeGap(0, "en")).toBe("0 min");
  });
});

describe("S1 search, selection and duplicates", () => {
  it("matches the title, else the first prompt with the text around the hit", () => {
    const pg = conversation("x", "壓測筆記", messages("x", [null, null], (n) => (n === 1 ? "-c 200 跑 10 分鐘（pgbench）的結果" : "TPS 1840")));
    expect(matchSession(sessionA().conversation, "pg")).toEqual({ inTitle: true, prompt: null });
    expect(matchSession(pg, "PG")).toEqual({ inTitle: false, prompt: { before: "-c 200 跑 10 分鐘（", hit: "pg", after: "bench）的結果" } });
    expect(matchSession(pg, "微分幾何")).toBeNull();
    expect(matchSession(pg, "  ")).toEqual({ inTitle: false, prompt: null });
  });

  it("sums up the selection: count, messages and the dated range", () => {
    expect(selectionSummary(designSessions())).toEqual({ count: 5, messages: 54, from: at(12, 14, 20), to: at(20, 21, 35) });
    expect(selectionSummary([])).toEqual({ count: 0, messages: 0, from: null, to: null });
  });

  it("finds a line with the same title started the same day, or a source id imported in this session (decision #10)", () => {
    const a = sessionA();
    const lines = [{ id: "l1", title: " pg 連線池設定 ", folder: "資料庫與儲存", createdAt: at(12, 14, 20) }];
    expect(findDuplicate(a, lines, new Set())).toEqual({ lineId: "l1", title: " pg 連線池設定 ", folder: "資料庫與儲存", date: at(12, 14, 20) });
    expect(findDuplicate(a, [{ ...lines[0]!, createdAt: at(25, 14, 20) }], new Set())).toBeNull();
    expect(findDuplicate(a, [], new Set(["chatgpt:ca"]))).toMatchObject({ lineId: null, title: "PG 連線池設定" });
    expect(sessionSourceId("chatgpt", a.conversation)).toBe("chatgpt:ca");
    expect(sessionSourceId("markdown", sessionD().conversation)).toBeNull();
    expect(findDuplicate(sessionD(), [], new Set(["markdown:壓測筆記"]))).toBeNull();
  });
});
