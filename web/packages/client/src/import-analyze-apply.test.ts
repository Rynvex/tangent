import { describe, expect, it } from "vitest";
import { applyAnalyzePlanToAssembly, expandSessionsToTurnUnits, sessionsToUnits, turnKey } from "./import-analyze-apply";
import { analyzeExcerpts, analyzeImportLocal, cutRunes } from "./import-analyze-local";
import { moveUnitBetweenNodes, NEW_BRANCH, NEW_STANDALONE, syncAnalyzePlan } from "./import-analyze-move";
import { buildAssemblyBlueprint } from "./import-assembly-build";
import { applySessionMerges, removeSessionMerge } from "./import-assembly-merge";
import { INTERLEAVED_ROUNDS, interleavedConversation } from "./import-combined-fixtures";
import { parseImport } from "./import-parsers";
import type { TimelineSession } from "./import-timeline";
import type { ParsedMessage } from "./import-tree";

/** The six interleaved rounds as one picked conversation. */
function mixedSession(): TimelineSession {
  const parsed = parseImport(JSON.stringify(interleavedConversation()), { fileName: "電腦雜談.json" });
  if (!parsed.ok) throw new Error(parsed.error);
  return { key: "s1", conversation: parsed.value.conversations[0]!, source: parsed.value.source, fileName: "電腦雜談.json", pickOrder: 0 };
}

const options = { title: "", folder: "", tags: [] };
const t = (k: number) => turnKey("s1", k);

/** The assembly an applied plan makes (as F14's step 2 would show it). */
function blueprintOf(applied: ReturnType<typeof applyAnalyzePlanToAssembly>) {
  const edits = { roles: applied.roles, attach: applied.attach, conclusions: applied.conclusions };
  const merged = applySessionMerges(applied.sessions, applied.merges, edits);
  return buildAssemblyBlueprint({ mode: applied.mode, sessions: merged.sessions, edits: merged.edits, options, relations: false });
}

describe("expanding a conversation into its rounds", () => {
  it("makes one session and one unit per round, keeping the source's id and the messages' ids", () => {
    // Arrange
    const session = mixedSession();
    // Act
    const { turnSessions, units } = expandSessionsToTurnUnits([session]);
    // Assert
    expect(turnSessions.map((turn) => turn.key)).toEqual([1, 2, 3, 4, 5, 6].map(t));
    expect(turnSessions.every((turn) => turn.conversation.id === session.conversation.id && turn.conversation.messages.length === 2)).toBe(true);
    expect(turnSessions[1]!.conversation.title).toBe(INTERLEAVED_ROUNDS[1]![0]);
    expect(units[3]).toEqual({ key: t(4), question: INTERLEAVED_ROUNDS[3]![0], answer: INTERLEAVED_ROUNDS[3]![1], messageCount: 2 });
  });

  it("leaves out removed messages and applies switched roles", () => {
    const session = mixedSession();
    const [first, second] = session.conversation.messages;
    const { turnSessions } = expandSessionsToTurnUnits([session], { messages: { s1: { roles: {}, removed: new Set([second!.externalId]) } } });
    expect(turnSessions[0]!.conversation.messages.map((message) => message.externalId)).toEqual([first!.externalId]);
  });

  it("can also send whole sessions as units", () => {
    expect(sessionsToUnits([mixedSession()])).toMatchObject([{ key: "s1", title: "電腦雜談", question: INTERLEAVED_ROUNDS[0]![0], messageCount: 12 }]);
  });
});

describe("applying a plan to the assembly", () => {
  it("draws §1 from A's three rounds with B and C hung on it as branches with their cards", () => {
    // Arrange
    const { turnSessions, units } = expandSessionsToTurnUnits([mixedSession()]);
    const plan = analyzeImportLocal({ units });
    // Act
    const applied = applyAnalyzePlanToAssembly(turnSessions, plan);
    const blueprint = blueprintOf(applied);
    // Assert
    expect(applied.mode).toBe("tree");
    expect(applied.order).toEqual([1, 3, 5, 2, 6, 4].map(t));
    expect(applied.merges).toEqual([
      { targetKey: t(1), absorbedKeys: [t(3), t(5)] },
      { targetKey: t(2), absorbedKeys: [t(6)] },
    ]);
    expect(applied.unitMap).toEqual({ [t(1)]: [1, 3, 5].map(t), [t(2)]: [2, 6].map(t), [t(4)]: [t(4)] });
    expect(blueprint.problems).toEqual([]);
    expect(blueprint.nodes.map((node) => [node.key, node.role, node.chapter, node.messages])).toEqual([
      [t(1), "chapter", 1, 6],
      [t(2), "merged_branch", null, 4],
      [t(4), "merged_branch", null, 2],
    ]);
    const [, b, c] = blueprint.nodes;
    expect(b!.attach).toMatchObject({ chapter: 1, number: 2, valid: true, auto: false });
    expect(c!.attach).toMatchObject({ chapter: 1, number: 4, valid: true });
    expect(b!.card?.conclusion).toBe(INTERLEAVED_ROUNDS[5]![1]);
    expect(blueprint.summary).toMatchObject({ lines: 1, chapters: 1, branches: 2, cards: 2, messages: 12 });
    expect(applied.reasons[t(1)]).toContain("#1、#3、#5");
  });

  it("is lossless: removing the merges gives the six rounds back", () => {
    const { turnSessions, units } = expandSessionsToTurnUnits([mixedSession()]);
    const applied = applyAnalyzePlanToAssembly(turnSessions, analyzeImportLocal({ units }));
    const unmerged = applied.merges.reduce((merges, merge) => removeSessionMerge(merges, merge.targetKey), applied.merges);
    expect(applySessionMerges(applied.sessions, unmerged).sessions.map((session) => session.conversation.messages.length)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("titles a node's first session as the node and folds merges already made", () => {
    const sessions = expandSessionsToTurnUnits([mixedSession()]).turnSessions;
    const plan = { mode: "tree" as const, source: "model" as const, summary: "", nodes: [{ key: t(1), unitKeys: [1, 2, 3, 4, 5, 6].map(t), title: "電腦", role: "chapter" as const }] };
    const applied = applyAnalyzePlanToAssembly(sessions, plan, [{ targetKey: t(5), absorbedKeys: [t(6)] }]);
    expect(applied.sessions[0]!.conversation.title).toBe("電腦");
    expect(applied.merges).toEqual([{ targetKey: t(1), absorbedKeys: [2, 3, 4, 5, 6].map(t) }]);
  });
});

describe("moving one round on the tree", () => {
  const setup = () => {
    const { units } = expandSessionsToTurnUnits([mixedSession()]);
    return { units, plan: analyzeImportLocal({ units }) };
  };

  it("moves a round into another node", () => {
    const { units, plan } = setup();
    const moved = moveUnitBetweenNodes(plan, t(5), t(2), { units });
    expect(moved.nodes.map((node) => node.unitKeys)).toEqual([[1, 3].map(t), [2, 5, 6].map(t), [t(4)]]);
    expect(plan.nodes[0]!.unitKeys).toHaveLength(3);
  });

  it("splits a round out as a branch hung on the chapter it falls inside, or as its own conversation", () => {
    const { units, plan } = setup();
    const branched = moveUnitBetweenNodes(plan, t(3), NEW_BRANCH, { units });
    expect(branched.nodes.find((node) => node.key === t(3))).toMatchObject({ role: "merged_branch", attachToKey: t(1), attachAfterUnitKey: t(1), conclusion: INTERLEAVED_ROUNDS[2]![1] });
    const alone = moveUnitBetweenNodes(plan, t(6), NEW_STANDALONE, { units });
    expect(alone.nodes.find((node) => node.key === t(6))).toMatchObject({ role: "standalone", unitKeys: [t(6)] });
    expect(alone.nodes.find((node) => node.key === t(6))).not.toHaveProperty("attachToKey");
  });

  it("renames a node whose first round moved away, keeping its branches on it", () => {
    const { units, plan } = setup();
    const moved = moveUnitBetweenNodes(plan, t(1), NEW_STANDALONE, { units });
    expect(moved.nodes.map((node) => [node.key, node.role, node.attachToKey])).toEqual([
      [t(1), "standalone", undefined],
      [t(2), "merged_branch", t(3)],
      [t(3), "chapter", undefined],
      [t(4), "merged_branch", t(3)],
    ]);
    expect(moved.nodes.find((node) => node.key === t(2))).not.toHaveProperty("attachAfterUnitKey");
  });

  it("keeps the plan when nothing would change", () => {
    const { units, plan } = setup();
    expect(moveUnitBetweenNodes(plan, t(1), t(1), { units })).toBe(plan);
    expect(moveUnitBetweenNodes(plan, "nope", t(2), { units })).toBe(plan);
    expect(moveUnitBetweenNodes(plan, t(4), NEW_BRANCH, { units })).toBe(plan);
  });

  it("writes the user's role and attach choices back before a move", () => {
    const { units, plan } = setup();
    const synced = syncAnalyzePlan(plan, { roles: { [t(4)]: "standalone", [t(2)]: "open_branch" }, attach: { [t(2)]: { sessionKey: t(3), externalId: "x" } } }, { units });
    expect(synced.nodes.find((node) => node.key === t(4))).toMatchObject({ role: "standalone" });
    expect(synced.nodes.find((node) => node.key === t(2))).toMatchObject({ role: "open_branch", attachToKey: t(1), attachAfterUnitKey: t(3) });
    expect(synced.nodes.find((node) => node.key === t(2))).not.toHaveProperty("conclusion");
  });
});

describe("B26: what a unit sends to the server, and what is analysed locally", () => {
  const long = (char: string, n: number) => char.repeat(n);
  const session = (messages: ParsedMessage[]): TimelineSession => ({
    key: "s1",
    source: "chatgpt",
    fileName: "export.json",
    conversation: { id: "c1", title: "Long talk", createdAt: null, updatedAt: null, messages, branches: [], skippedBranches: 0 },
    pickOrder: 0,
    manualTime: null,
  });
  const messages: ParsedMessage[] = [
    { externalId: "m1", role: "user", content: long("問", 700), versions: 1, createdAt: "2026-03-01T09:00:00Z" },
    { externalId: "m2", role: "assistant", content: long("答", 2500), versions: 1, createdAt: "2026-03-01T09:00:30Z" },
    { externalId: "m3", role: "user", content: "second question", versions: 1 },
    { externalId: "m4", role: "assistant", content: "second answer", versions: 1 },
  ];

  it("sends up to 600 runes of the question and 2,000 of the answer, with startAt when the round has a real time", () => {
    const { units } = expandSessionsToTurnUnits([session(messages)]);
    expect(Array.from(units[0]!.question)).toHaveLength(600);
    expect(Array.from(units[0]!.answer)).toHaveLength(2000);
    expect(units[0]!.question.endsWith("…")).toBe(true);
    // As the import itself would send the message's time (ISO with milliseconds).
    expect(units[0]!.startAt).toBe("2026-03-01T09:00:00.000Z");
    // A round whose first message has no time sends none (never a made-up one).
    expect("startAt" in units[1]!).toBe(false);
    expect(units[1]).toMatchObject({ question: "second question", answer: "second answer", messageCount: 2 });
  });

  it("leaves out a time the server would refuse", () => {
    const odd = messages.map((message, index) => (index === 0 ? { ...message, createdAt: "March 1st" } : message));
    expect("startAt" in sessionsToUnits([session(odd)])[0]!).toBe(false);
  });

  it("gives the local analyzer the same 300-rune excerpts as before, so its plan does not change", () => {
    const { units } = expandSessionsToTurnUnits([session(messages)]);
    const excerpts = analyzeExcerpts(units);
    expect(Array.from(excerpts[0]!.question)).toHaveLength(300);
    expect(Array.from(excerpts[0]!.answer)).toHaveLength(300);
    expect(excerpts[1]).toEqual(units[1]);
    expect(analyzeExcerpts(excerpts)).toEqual(excerpts);
    // What was sent before B26: the same texts cut to 300 at once, no startAt.
    const before = units.map(({ startAt: _startAt, ...unit }) => ({ ...unit, question: cutRunes(long("問", 700), 300), answer: cutRunes(long("答", 2500), 300) })).slice(0, 1);
    const { startAt: _sent, ...first } = excerpts[0]!;
    expect(first).toEqual(before[0]);
    expect(analyzeImportLocal({ units })).toEqual(analyzeImportLocal({ units: [before[0]!, units[1]!] }));
  });
});
