import { describe, expect, it } from "vitest";
import { IMPORT_MAX_BRANCH_MESSAGES, IMPORT_MAX_BRANCHES, IMPORT_MAX_CHAPTER_CUTS, IMPORT_MAX_MESSAGES } from "./b18-routes";
import { buildAssemblyBlueprint } from "./import-assembly-build";
import { defaultAttachMessage, defaultRoles, effectiveRoles, prefillSessionCard, type AssemblyEdits, type AssemblyMode } from "./import-assembly";
import { addSessionMerge, applyBatchRole, applySessionMerges, mergedOrigin, mergeMembers, moveSessionsToIndex, removeSessionMerge } from "./import-assembly-merge";
import { at, conversation, designSessions, messages, session, sessionA, sessionB, sessionC, sessionE, sized } from "./import-fixtures";
import { longCombinedExport } from "./import-combined-fixtures";
import { parseImport } from "./import-parsers";
import { orderByTime, placeSession, type TimelineSession } from "./import-timeline";

const options = { title: "", folder: "資料庫與儲存", tags: ["postgres", "連線池"] };
const build = (mode: AssemblyMode, sessions: readonly TimelineSession[] = designSessions(), edits: AssemblyEdits = {}, relations = true) => buildAssemblyBlueprint({ mode, sessions, edits, options, relations });
const kinds = (blueprint: ReturnType<typeof build>) => blueprint.problems.map((problem) => problem.kind);

describe("default roles", () => {
  it("timeline makes every session a chapter, batch every one standalone", () => {
    expect(Object.values(defaultRoles("timeline", designSessions()))).toEqual(["chapter", "chapter", "chapter", "chapter", "chapter"]);
    expect(Object.values(defaultRoles("batch", designSessions()))).toEqual(["standalone", "standalone", "standalone", "standalone", "standalone"]);
  });

  it("tree hangs a session starting inside the latest chapter's time on it (decision #3)", () => {
    // B starts inside A; D's file time (08/18) is after C ended, so D stays a chapter.
    expect(defaultRoles("tree", designSessions())).toEqual({ A: "chapter", B: "merged_branch", C: "chapter", D: "chapter", E: "chapter" });
  });

  it("tree without any overlap keeps only the first as a chapter when everything fits in 2,000", () => {
    const list = [sessionA(), sessionC(), sessionE()];
    expect(defaultRoles("tree", list)).toEqual({ A: "chapter", C: "merged_branch", E: "merged_branch" });
  });

  it("tree without any overlap keeps the first sessions within 2,000 messages when the whole is over 2,000", () => {
    const list = [sized("P", 900, at(1, 0, 0), 0), sized("Q", 900, at(2, 0, 0), 1), sized("R", 400, at(3, 0, 0), 2), sized("S", 300, at(4, 0, 0), 3)];
    expect(defaultRoles("tree", list)).toEqual({ P: "chapter", Q: "chapter", R: "merged_branch", S: "merged_branch" });
  });

  it("keeps the user's roles in tree, only `standalone` in timeline and none in batch", () => {
    const edits: AssemblyEdits = { roles: { C: "open_branch", E: "standalone" } };
    expect(effectiveRoles("tree", designSessions(), edits)).toMatchObject({ C: "open_branch", E: "standalone" });
    expect(effectiveRoles("timeline", designSessions(), edits)).toMatchObject({ C: "chapter", E: "standalone" });
    expect(effectiveRoles("batch", designSessions(), edits)).toMatchObject({ C: "standalone", E: "standalone" });
  });
});

describe("attach points and cards", () => {
  it("hangs a branch on the chapter's last message at or before its start", () => {
    // B starts 15:10; A's #4 is 14:58, #5 is 17:35.
    expect(defaultAttachMessage(sessionA(), Date.parse(at(12, 15, 10)))).toBe("a4");
  });

  it("uses the chapter's first reply when the branch is earlier than all of it, and the last message when undated", () => {
    expect(defaultAttachMessage(sessionA(), Date.parse(at(1, 0, 0)))).toBe("a2");
    expect(defaultAttachMessage(sessionA(), null)).toBe("a12");
    expect(defaultAttachMessage(sessionA(), Date.parse(at(12, 15, 10)), { messages: { A: { roles: {}, removed: new Set(["a4"]) } } })).toBe("a3");
  });

  it("prefills a card with the title and the first sentence of the last reply, no model (decision #6)", () => {
    expect(prefillSessionCard(sessionB())).toEqual({ question: "PgBouncer transaction mode 的限制", conclusion: "不能用 session 層級的 SET；改用 SET LOCAL。" });
    const untitled = session("U", conversation("u", "", messages("u", [null], () => "一個很長的提問".repeat(20))), "text", 0);
    expect(Array.from(prefillSessionCard(untitled).question)).toHaveLength(60);
  });
});

describe("timeline blueprint (mode A)", () => {
  it("joins every session into one main line with a cut at each start and every message's date", () => {
    // Act
    const blueprint = build("timeline");
    const [main] = blueprint.imports;
    // Assert
    expect(blueprint.imports).toHaveLength(1);
    expect(main!.messages).toHaveLength(54);
    expect(main!.title).toBe("PG 連線池設定");
    expect(main!.folder).toBe("資料庫與儲存");
    expect(main!.source).toBe("chatgpt+claude+markdown");
    expect(main!.createdAt).toBe(at(12, 14, 20));
    expect(main!.chapterCuts).toEqual([
      { anchorExternalId: "c1-m1", title: "PG 連線池設定" },
      { anchorExternalId: "c2-m1", title: "PgBouncer transaction mode 的限制" },
      { anchorExternalId: "c3-m1", title: "高併發壓測與鎖等待" },
      { anchorExternalId: "c4-m1", title: "壓測筆記" },
      { anchorExternalId: "c5-m1", title: "最終設定檔" },
    ]);
    expect(main!.messages[0]).toMatchObject({ externalId: "c1-m1", createdAt: at(12, 14, 20) });
    // The file-dated session sends no dates (the server dates them after the message above).
    expect(main!.messages.filter((message) => (message.externalId ?? "").startsWith("c4-")).every((message) => message.createdAt === undefined)).toBe(true);
    // A's regenerated reply goes along as a discarded version.
    expect(main!.branches).toHaveLength(1);
    expect(main!.branches![0]).toMatchObject({ anchorExternalId: "c1-m5", purpose: "（重新生成）A 第 5 則。" });
    expect(main!.branches![0]!.status).toBeUndefined();
  });

  it("warns about the overlap and recommends the tree, without blocking (decision #1)", () => {
    const blueprint = build("timeline");
    expect(blueprint.interleaves).toEqual([{ inner: "B", outer: "A", at: Date.parse(at(12, 15, 10)) }]);
    expect(blueprint.nodes.find((node) => node.key === "B")!.interleaved).toBe(true);
    expect(blueprint.recommendTree).toBe(true);
    expect(blueprint.problems).toEqual([]);
    expect(blueprint.summary).toMatchObject({ lines: 1, chapters: 5, branches: 0, messages: 54, from: at(12, 14, 20), to: at(20, 21, 35) });
  });

  it("blocks over 2,000 main-line messages and recommends the tree, never switching (decision #2)", () => {
    const list = [sized("P", 1500, at(1, 0, 0), 0), sized("Q", 586, at(3, 0, 0), 1)];
    const blueprint = build("timeline", list);
    expect(blueprint.mode).toBe("timeline");
    expect(blueprint.problems).toEqual([{ kind: "over200", messages: 2086 }]);
    expect(blueprint.recommendTree).toBe(true);
    // Q is too long for a branch and for the main line: the tree makes it a separate conversation (B21).
    expect(defaultRoles("tree", list)).toEqual({ P: "chapter", Q: "standalone" });
    expect(build("tree", list).problems).toEqual([]);
  });

  it("does not cut a single chapter, and blocks more than 50 chapters", () => {
    expect(build("timeline", [sessionA()]).imports[0]!.chapterCuts).toBeUndefined();
    const many = Array.from({ length: IMPORT_MAX_CHAPTER_CUTS + 1 }, (_, i) => sized(`S${i}`, 2, at(1, 0, i * 5), i));
    expect(kinds(build("timeline", many))).toEqual(["tooManyChapters"]);
  });
});

describe("tree blueprint (mode B)", () => {
  it("brings B back on §1 #4 with its card and keeps the other sessions as chapters", () => {
    // Act
    const blueprint = build("tree");
    const [main] = blueprint.imports;
    const b = blueprint.nodes.find((node) => node.key === "B")!;
    // Assert
    expect(b).toMatchObject({ role: "merged_branch", chapter: null, card: { question: "PgBouncer transaction mode 的限制", conclusion: "不能用 session 層級的 SET；改用 SET LOCAL。" } });
    expect(b.attach).toMatchObject({ point: { sessionKey: "A", externalId: "a4" }, chapter: 1, number: 4, at: Date.parse(at(12, 14, 58)), auto: true, valid: true });
    expect(main!.messages).toHaveLength(50);
    expect(main!.chapterCuts!.map((cut) => cut.anchorExternalId)).toEqual(["c1-m1", "c2-m1", "c3-m1", "c4-m1"]);
    expect(main!.branches![0]).toEqual({
      anchorExternalId: "c1-m4",
      purpose: "PgBouncer transaction mode 的限制",
      kind: "investigate",
      status: "merged",
      card: { question: "PgBouncer transaction mode 的限制", conclusion: "不能用 session 層級的 SET；改用 SET LOCAL。" },
      createdAt: at(12, 15, 10),
      messages: sessionB().conversation.messages.map((message) => ({ role: message.role, content: message.content, createdAt: message.createdAt })),
    });
    expect(blueprint.summary).toMatchObject({ lines: 1, chapters: 4, branches: 1, cards: 1, messages: 54 });
  });

  it("takes the edited conclusion, and blocks an empty one", () => {
    expect(build("tree", designSessions(), { conclusions: { B: "改用 SET LOCAL。" } }).imports[0]!.branches![0]!.card).toEqual({ question: "PgBouncer transaction mode 的限制", conclusion: "改用 SET LOCAL。" });
    expect(build("tree", designSessions(), { conclusions: { B: "  " } }).problems).toEqual([{ kind: "cardEmpty", key: "B" }]);
  });

  it("makes an open branch without a card, on the attach point the user chose", () => {
    const edits: AssemblyEdits = { roles: { D: "open_branch" }, attach: { D: { sessionKey: "C", externalId: "c18" } } };
    const blueprint = build("tree", designSessions(), edits);
    const branch = blueprint.imports[0]!.branches!.find((item) => item.purpose === "壓測筆記")!;
    expect(branch).toMatchObject({ anchorExternalId: "c2-m18", status: "open" });
    expect(branch.card).toBeUndefined();
    expect(blueprint.nodes.find((node) => node.key === "D")!.attach).toMatchObject({ chapter: 2, number: 18, auto: false, valid: true });
  });

  it("flags a branch whose chosen attach point is no longer a chapter and leaves it out", () => {
    const edits: AssemblyEdits = { roles: { D: "merged_branch", E: "merged_branch" }, attach: { D: { sessionKey: "E", externalId: "e8" } } };
    const blueprint = build("tree", designSessions(), edits);
    expect(blueprint.problems).toContainEqual({ kind: "invalidAttach", key: "D", target: "E" });
    expect(blueprint.imports[0]!.branches!.map((item) => item.purpose)).not.toContain("壓測筆記");
    expect(blueprint.nodes.find((node) => node.key === "D")!.attach!.valid).toBe(false);
  });

  it("blocks a branch over 500 messages, more than 50 branches and more than 8 open ones, when the user chose them", () => {
    const long = [sized("P", 10, at(1, 0, 0), 0), sized("Q", IMPORT_MAX_BRANCH_MESSAGES + 1, at(2, 0, 0), 1)];
    expect(kinds(build("tree", long, { roles: { Q: "merged_branch" } }))).toEqual(["branchTooLong"]);
    const many = [sized("T", 2, at(1, 0, 0), 0), ...Array.from({ length: IMPORT_MAX_BRANCHES + 1 }, (_, i) => sized(`S${i}`, 1, at(2, 0, i * 5), i + 1))];
    const allBranches = Object.fromEntries(many.slice(1).map((item) => [item.key, "merged_branch" as const]));
    expect(kinds(build("tree", many, { roles: allBranches }))).toEqual(["tooManyBranches"]);
    const open = Object.fromEntries(many.slice(1, 10).map((item) => [item.key, "open_branch" as const]));
    expect(kinds(build("tree", many.slice(0, 10), { roles: open }))).toEqual(["tooManyOpen"]);
  });

  it("needs a chapter", () => {
    const edits: AssemblyEdits = { roles: { A: "merged_branch", B: "merged_branch", C: "merged_branch", D: "merged_branch", E: "merged_branch" } };
    const blueprint = build("tree", designSessions(), edits);
    expect(kinds(blueprint)).toContain("noChapter");
    expect(blueprint.imports).toEqual([]);
  });

  it("keeps the 50-branch limit by leaving restored versions out first", () => {
    const withVersions = { ...sessionA(), conversation: { ...sessionA().conversation, branches: Array.from({ length: IMPORT_MAX_BRANCHES + 5 }, () => ({ anchorExternalId: "a5", reason: "regenerate" as const, messages: [{ role: "assistant" as const, content: "舊" }] })) } };
    const blueprint = build("tree", [withVersions, sessionB(), sessionC()]);
    expect(blueprint.imports[0]!.branches).toHaveLength(IMPORT_MAX_BRANCHES);
    expect(blueprint.droppedVersions).toBe(6);
    expect(blueprint.problems).toEqual([]);
  });

  it("sends the edited roles and leaves removed messages out", () => {
    const edits: AssemblyEdits = { messages: { A: { roles: { a1: "assistant" }, removed: new Set(["a2"]) } } };
    const [main] = build("tree", designSessions(), edits).imports;
    expect(main!.messages[0]).toMatchObject({ role: "assistant", content: "PgBouncer 要用哪種 pool mode？" });
    expect(main!.messages).toHaveLength(49);
  });
});

describe("standalone nodes and batch (mode C, decision #7)", () => {
  it("imports a standalone node on its own, placed in time order next to the tree", () => {
    const blueprint = build("tree", designSessions(), { roles: { C: "standalone" } });
    expect(blueprint.imports.map((input) => input.title)).toEqual(["PG 連線池設定", "高併發壓測與鎖等待"]);
    expect(blueprint.importKeys).toEqual([["A", "B", "D", "E"], ["C"]]);
    expect(blueprint.summary).toMatchObject({ lines: 2, relations: 1 });
  });

  it("imports every session on its own in order, in the same folder with the same tags", () => {
    const blueprint = build("batch");
    expect(blueprint.imports.map((input) => [input.title, input.folder, input.tags])).toEqual(
      ["PG 連線池設定", "PgBouncer transaction mode 的限制", "高併發壓測與鎖等待", "壓測筆記", "最終設定檔"].map((title) => [title, "資料庫與儲存", ["postgres", "連線池"]]),
    );
    expect(blueprint.imports[0]!.createdAt).toBe(at(12, 14, 20));
    expect(blueprint.imports[3]!.createdAt).toBeUndefined();
    expect(blueprint.summary).toMatchObject({ lines: 5, chapters: 0, branches: 0, relations: 4 });
  });

  it("still works with relations off, making none", () => {
    const blueprint = build("batch", designSessions(), {}, false);
    expect(blueprint.problems).toEqual([]);
    expect(blueprint.summary.relations).toBe(0);
  });

  it("blocks a session over 2,000 messages in batch, and a bad folder for everything", () => {
    expect(kinds(build("batch", [sized("P", IMPORT_MAX_MESSAGES + 1, at(1, 0, 0))]))).toEqual(["sessionTooLong"]);
    const bad = buildAssemblyBlueprint({ mode: "batch", sessions: [sessionE()], edits: {}, options: { ...options, folder: "__unfiled__" }, relations: true });
    expect(kinds(bad)).toEqual(["folder"]);
  });
});

describe("review fixes", () => {
  const fileDated = (key: string, pickOrder: number) => session(key, conversation(key, key, messages(key, [null, null]), { timeSource: "file", fileTime: at(18, 9, 0) }), "markdown", pickOrder);

  it("does not take files with the same modified time for an overlap (only real spans count)", () => {
    // Arrange: three files unpacked together share one modified time.
    const list = [fileDated("P", 0), fileDated("Q", 1), fileDated("R", 2)];
    // Act / Assert: the no-overlap rule applies (only the first stays a chapter), and nothing warns.
    expect(defaultRoles("tree", list)).toEqual({ P: "chapter", Q: "merged_branch", R: "merged_branch" });
    expect(build("timeline", list).interleaves).toEqual([]);
  });

  it("blocks a date the server refuses (a time set more than a day ahead, or before 1970)", () => {
    const now = Date.parse("2026-11-02T00:00:00Z");
    const ahead = { ...sessionE(), manualTime: "2026-11-04T00:00:00.000Z" };
    const blueprint = buildAssemblyBlueprint({ mode: "batch", sessions: [ahead], edits: {}, options, relations: true, now });
    expect(kinds(blueprint)).toEqual(["dateOutOfRange"]);
    const old = session("O", conversation("o", "o", messages("o", ["1969-12-31T00:00:00.000Z"])), "chatgpt", 0);
    expect(kinds(buildAssemblyBlueprint({ mode: "batch", sessions: [old], edits: {}, options, relations: true, now }))).toEqual(["dateOutOfRange"]);
    expect(buildAssemblyBlueprint({ mode: "batch", sessions: [sessionE()], edits: {}, options, relations: true, now }).problems).toEqual([]);
  });

  it("blocks a separate conversation over 16 MiB before sending it", () => {
    const huge = session("H", conversation("h", "h", messages("h", Array.from({ length: 200 }, () => null), () => "字".repeat(30_000))), "chatgpt", 0);
    expect(kinds(build("batch", [huge]))).toEqual(["bodyTooLarge"]);
  });
});

describe("tree defaults within the limits (B21)", () => {
  it("makes a branch over 500 messages a chapter while the main line has room", () => {
    const list = [sized("P", 10, at(1, 0, 0), 0), sized("Q", IMPORT_MAX_BRANCH_MESSAGES + 1, at(2, 0, 0), 1), sized("R", 4, at(3, 0, 0), 2)];
    expect(defaultRoles("tree", list)).toEqual({ P: "chapter", Q: "chapter", R: "merged_branch" });
    expect(build("tree", list).problems).toEqual([]);
  });

  it("past 50 branches makes the next sessions chapters, then separate conversations past 50 chapters", () => {
    const many = Array.from({ length: 1 + IMPORT_MAX_BRANCHES + IMPORT_MAX_CHAPTER_CUTS + 2 }, (_, i) => sized(`S${i}`, 2, at(1, 0, i * 5), i));
    const roles = Object.values(defaultRoles("tree", many));
    expect(roles.filter((role) => role === "merged_branch")).toHaveLength(IMPORT_MAX_BRANCHES);
    expect(roles.filter((role) => role === "chapter")).toHaveLength(IMPORT_MAX_CHAPTER_CUTS);
    expect(roles.filter((role) => role === "standalone")).toHaveLength(3);
    expect(roles.slice(0, IMPORT_MAX_BRANCHES + 2)).toEqual(["chapter", ...Array.from({ length: IMPORT_MAX_BRANCHES }, () => "merged_branch"), "chapter"]);
    expect(build("tree", many).problems).toEqual([]);
  });

  it("moves an overlapping session's chapter that does not fit to a branch", () => {
    // B overlaps A (a branch); C and D are chapters by time, but D does not fit beside A and C.
    const list = [sized("A", 1500, at(1, 0, 0), 0), sized("B", 4, at(1, 1, 0), 1), sized("C", 400, at(3, 0, 0), 2), sized("D", 300, at(5, 0, 0), 3)];
    expect(defaultRoles("tree", list)).toEqual({ A: "chapter", B: "merged_branch", C: "chapter", D: "merged_branch" });
    expect(build("tree", list).problems).toEqual([]);
  });

  it("keeps the user's choice even when it breaks a limit", () => {
    const list = [sized("P", 10, at(1, 0, 0), 0), sized("Q", IMPORT_MAX_BRANCH_MESSAGES + 100, at(2, 0, 0), 1)];
    expect(effectiveRoles("tree", list, { roles: { Q: "merged_branch" } }).Q).toBe("merged_branch");
    expect(build("tree", list, { roles: { Q: "merged_branch" } }).problems).toContainEqual({ kind: "branchTooLong", key: "Q", messages: IMPORT_MAX_BRANCH_MESSAGES + 100 });
  });
});

describe("a 750-message combined export (B21)", () => {
  const sessions = (): TimelineSession[] => {
    const parsed = parseImport(JSON.stringify(longCombinedExport()), { fileName: "Gemini-Combined_雜談-2026-11-03.json" });
    if (!parsed.ok) throw new Error(parsed.error);
    const list = parsed.value.conversations.map((item, index) => session(item.id, item, parsed.value.source, index));
    const byKey = new Map(list.map((item) => [item.key, item]));
    return orderByTime(list).map((key) => byKey.get(key)!);
  };

  it.each(["timeline", "tree", "batch"] as const)("imports in %s mode without any problem", (mode) => {
    const list = sessions();
    expect(list.reduce((sum, item) => sum + item.conversation.messages.length, 0)).toBe(750);
    const blueprint = buildAssemblyBlueprint({ mode, sessions: list, edits: {}, options: { title: "", folder: "雜談", tags: [] }, relations: true });
    expect(blueprint.problems).toEqual([]);
    expect(blueprint.summary.messages).toBe(750);
  });

  it("keeps the file's order: the timeline's chapters are the topics from top to bottom", () => {
    const blueprint = buildAssemblyBlueprint({ mode: "timeline", sessions: sessions(), edits: {}, options: { title: "", folder: "雜談", tags: [] }, relations: true });
    const cuts = blueprint.imports[0]!.chapterCuts!.map((cut) => cut.title);
    expect(cuts).toHaveLength(25);
    expect(cuts[0]).toBe("Docker 容器是什麼?");
    expect(cuts[1]).toBe("Kubernetes 叢集是什麼?");
    expect(cuts.at(-1)).toBe("Marathon 跑步是什麼?");
  });
});

describe("merging and splitting sessions (F16.1)", () => {
  /** A topic cut out of a combined export: its ids restart at "0-user" like every other topic's. */
  const topic = (key: string, title: string, start: string, count: number, pickOrder: number): TimelineSession => {
    const base = Date.parse(start);
    const list = Array.from({ length: count }, (_, i) => ({
      externalId: `${i}-${i % 2 === 0 ? "user" : "assistant"}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${title} ${i + 1}。`,
      versions: 1,
      createdAt: new Date(base + i * 60_000).toISOString(),
    }));
    return session(key, conversation(`c-${key}`, title, list), "gemini", pickOrder);
  };
  const withVersion = (item: TimelineSession): TimelineSession => ({ ...item, conversation: { ...item.conversation, branches: [{ anchorExternalId: "1-assistant", reason: "regenerate", messages: [{ role: "assistant", content: "舊的。" }] }] } });
  const three = () => [topic("P", "CPU 散熱", at(1, 10, 0), 4, 0), withVersion(topic("Q", "散熱膏", at(1, 11, 0), 4, 1)), topic("R", "Firebase", at(1, 12, 0), 2, 2)];
  const keys = (list: readonly TimelineSession[]) => list.map((item) => item.key);
  const edits: AssemblyEdits = {
    roles: { Q: "chapter", R: "merged_branch" },
    attach: { R: { sessionKey: "Q", externalId: "2-user" } },
    conclusions: { Q: "Q 的結論。" },
    messages: { Q: { roles: { "0-user": "assistant" }, removed: new Set(["1-assistant"]) } },
  };

  it("joins two sessions, renaming the absorbed one's ids and carrying its edits and the branch hung on it", () => {
    // Arrange
    const merges = addSessionMerge([], ["P", "Q", "R"], ["Q", "P"]);
    // Act
    const applied = applySessionMerges(three(), merges, edits);
    // Assert
    expect(merges).toEqual([{ targetKey: "P", absorbedKeys: ["Q"] }]);
    expect(keys(applied.sessions)).toEqual(["P", "R"]);
    const merged = applied.sessions[0]!.conversation;
    expect(merged.title).toBe("CPU 散熱");
    expect(merged.messages.map((message) => message.externalId)).toEqual(["0-user", "1-assistant", "2-user", "3-assistant", "m1_0-user", "m1_1-assistant", "m1_2-user", "m1_3-assistant"]);
    expect(merged.branches.map((branch) => branch.anchorExternalId)).toEqual(["m1_1-assistant"]);
    expect(merged.createdAt).toBe(at(1, 10, 0));
    expect(merged.updatedAt).toBe(new Date(Date.parse(at(1, 11, 0)) + 3 * 60_000).toISOString());
    expect(applied.mergedCounts.get("P")).toBe(2);
    expect(applied.edits.messages?.P?.roles).toEqual({ "m1_0-user": "assistant" });
    expect([...applied.edits.messages!.P!.removed]).toEqual(["m1_1-assistant"]);
    expect(applied.edits.attach).toEqual({ R: { sessionKey: "P", externalId: "m1_2-user" } });
    expect(applied.edits.roles).toEqual({ R: "merged_branch" });
    expect(applied.edits.conclusions).toEqual({});
    // One conversation of 7 kept messages (8 less the removed one) with R hung on it.
    const blueprint = build("tree", applied.sessions, applied.edits);
    expect(blueprint.imports).toHaveLength(1);
    expect(blueprint.imports[0]!.messages).toHaveLength(7);
    expect(blueprint.nodes.find((node) => node.key === "R")?.attach?.point).toEqual({ sessionKey: "P", externalId: "m1_2-user" });
    expect(blueprint.problems).toEqual([]);
  });

  it("merges a third one into the same record, also when a merged session is merged again", () => {
    const once = addSessionMerge([], ["P", "Q", "R"], ["P", "Q"]);
    const twice = addSessionMerge(once, ["P", "R"], ["P", "R"]);
    expect(twice).toEqual([{ targetKey: "P", absorbedKeys: ["Q", "R"] }]);
    // Q+R first, then P with that merged Q: one record, the earliest first.
    const nested = addSessionMerge(addSessionMerge([], ["P", "Q", "R"], ["Q", "R"]), ["P", "Q"], ["Q", "P"]);
    expect(nested).toEqual(twice);
    const applied = applySessionMerges(three(), twice, edits);
    expect(keys(applied.sessions)).toEqual(["P"]);
    expect(applied.sessions[0]!.conversation.messages.map((message) => message.externalId).slice(-2)).toEqual(["m2_0-user", "m2_1-assistant"]);
    expect(applied.mergedCounts.get("P")).toBe(3);
    // R was hung on Q; both are inside P now, so it has no attach point of its own.
    expect(applied.edits.attach).toEqual({});
    expect(mergeMembers(twice, "P")).toEqual(["P", "Q", "R"]);
    expect(mergedOrigin(three(), twice, "P", "m2_1-assistant")).toEqual({ sessionKey: "R", externalId: "1-assistant" });
    expect(mergedOrigin(three(), twice, "P", "3-assistant")).toEqual({ sessionKey: "P", externalId: "3-assistant" });
  });

  it("keeps a dropped-on target and still joins the parts oldest first", () => {
    const merges = addSessionMerge([], ["P", "Q", "R"], ["P"], "R");
    expect(merges).toEqual([{ targetKey: "R", absorbedKeys: ["P"] }]);
    const merged = applySessionMerges(three(), merges).sessions.find((item) => item.key === "R")!;
    expect(merged.conversation.title).toBe("Firebase");
    expect(merged.conversation.messages[0]!.externalId).toBe("m1_0-user");
    expect(merged.conversation.messages.at(-1)!.externalId).toBe("1-assistant");
  });

  it("splits a merge back into the sessions and edits it was made of", () => {
    const merges = addSessionMerge([], ["P", "Q", "R"], ["P", "Q", "R"]);
    const applied = applySessionMerges(three(), removeSessionMerge(merges, "P"), edits);
    expect(keys(applied.sessions)).toEqual(["P", "Q", "R"]);
    expect(applied.edits).toBe(edits);
    expect(applied.mergedCounts.size).toBe(0);
    expect(addSessionMerge([], ["P", "Q"], ["P"])).toEqual([]);
  });

  it("keeps a merged session's limits: a branch over 500 still says so", () => {
    const long = [sized("L", 300, at(1, 0, 0), 0), sized("M", 250, at(2, 0, 0), 1), sized("N", 10, at(3, 0, 0), 2)];
    const applied = applySessionMerges(long, addSessionMerge([], ["L", "M", "N"], ["L", "M"]));
    expect(build("tree", applied.sessions, { roles: { L: "merged_branch", N: "chapter" } }).problems).toContainEqual({ kind: "branchTooLong", key: "L", messages: 550 });
  });
});

describe("batch roles and moves (F16.1)", () => {
  it("sets many sessions standalone or chapters at once", () => {
    const sessions = designSessions();
    expect(applyBatchRole({}, sessions, ["B", "D"], "standalone").roles).toEqual({ B: "standalone", D: "standalone" });
    expect(applyBatchRole({ roles: { A: "merged_branch" } }, sessions, ["A", "C"], "chapter").roles).toEqual({ A: "chapter", C: "chapter" });
  });

  it("hangs branches on the chapter they were dropped on, at the default point for their start, leaving the chapter itself", () => {
    const sessions = designSessions();
    const next = applyBatchRole({}, sessions, ["A", "B", "E"], "merged_branch", "A");
    expect(next.roles).toEqual({ B: "merged_branch", E: "merged_branch" });
    expect(next.attach).toEqual({ B: { sessionKey: "A", externalId: "a4" }, E: { sessionKey: "A", externalId: "a12" } });
    expect(build("tree", sessions, next).nodes.find((node) => node.key === "E")?.attach?.chapter).toBe(1);
  });

  it("moves one session like placeSession and several as a group in their order", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect(moveSessionsToIndex(order, ["b"], 3)).toEqual(placeSession(order, "b", 3));
    expect(moveSessionsToIndex(order, ["d", "b"], 0)).toEqual(["b", "d", "a", "c", "e"]);
    expect(moveSessionsToIndex(order, ["a", "b"], 9)).toEqual(["c", "d", "e", "a", "b"]);
    expect(moveSessionsToIndex(order, ["x"], 1)).toEqual(order);
  });
});
