import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import type { Term } from "../glossary-routes";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

/** B24 in the mock: the glossary with the server's rules, refusals and events (docs/devlog/B24-glossary.md). */

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof TangentError)) throw new Error(`expected a TangentError, got ${String(error)}`);
  return error;
}

let client: MockTangentClient;
let events: TangentEvent[];
function start(options: Parameters<typeof nasScenario>[0] = {}, terms: Term[] = []) {
  client?.mock.dispose();
  client = createMockTangentClient({ scenario: { ...nasScenario(options), terms }, latencyMs: 0, chunkMs: 5 });
  events = [];
  client.subscribe({ handlers: {}, onEvent: (event) => void events.push(event) });
}
beforeEach(() => {
  vi.useFakeTimers();
  start();
});
afterEach(() => {
  client.mock.dispose();
  vi.useRealTimers();
});

async function aside(purpose = "What is MVCC?", keep = false) {
  const made = await client.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "aside", ...(keep ? { keep: true } : {}) });
  await client.sendMessage(made.line.id, { content: purpose });
  await vi.runAllTimersAsync();
  return made.line.id;
}
const kinds = () => events.map((event) => (event.type === "branch.changed" ? `branch.changed:${event.data.change}` : event.type));

describe("mock glossary: saving", () => {
  it("cleans the term to one line, keys it, labels its source and lists the tree's terms by key", async () => {
    // Act
    const made = await client.createTerm(NAS_ROOT_ID, { term: "  Write \n Ahead　Log ", explanation: "  先寫日誌\r\n再寫資料  ", sourceMessageId: "nas-m17" });
    await client.createTerm("nas-b3", { term: "ＭＶＣＣ", explanation: "多版本並行控制" });

    // Assert
    expect(made).toMatchObject({ change: "created", term: { term: "Write Ahead Log", termKey: "writeaheadlog", explanation: "先寫日誌\n再寫資料", sourceLineId: NAS_ROOT_ID, sourceMessageId: "nas-m17", rootLineId: NAS_ROOT_ID } });
    expect(made.term.sourceLabel).toMatch(/^主線 #\d+$/);
    expect("keptBranch" in made).toBe(false);
    const listed = await client.listTerms("nas-b3");
    expect(listed.terms.map((term) => term.termKey)).toEqual(["mvcc", "writeaheadlog"]);
    expect(listed.terms[0]!.sourceLabel).toBe("查證・4TB 與 8TB 硬碟的每 TB 成本與保固");
    expect(listed.limits).toEqual({ maxTotal: 300, termMaxRunes: 60, explanationMaxRunes: 1000 });
    expect(events.filter((event) => event.type === "terms.changed").map((event) => [event.lineId, event.rootLineId, event.data])).toEqual([
      [NAS_ROOT_ID, NAS_ROOT_ID, { rootLineId: NAS_ROOT_ID, termId: made.term.id, change: "created" }],
      ["nas-b3", NAS_ROOT_ID, { rootLineId: NAS_ROOT_ID, termId: listed.terms[0]!.id, change: "created" }],
    ]);
  });

  it("refuses the same term in another spelling with the stored one, and overwrites explanation and source on replace", async () => {
    // Arrange
    const first = await client.createTerm(NAS_ROOT_ID, { term: "MVCC", explanation: "old" });

    // Act
    const refused = await rejection(client.createTerm("nas-b3", { term: "m v c c", explanation: "new" }));
    const replaced = await client.createTerm("nas-b3", { term: "mvcc", explanation: "new", replace: true });

    // Assert
    expect(refused).toMatchObject({ status: 409, code: "term_exists", extra: { term: { id: first.term.id, term: "MVCC", explanation: "old" } } });
    expect(replaced).toMatchObject({ change: "updated", term: { id: first.term.id, term: "MVCC", explanation: "new", sourceLineId: "nas-b3" } });
    expect((await client.listTerms(NAS_ROOT_ID)).terms).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "terms.changed", data: { change: "updated" } });
  });

  it("keeps the aside a term is saved from: terms.changed, then branch.changed{kept}; an aside kept already is not reported again", async () => {
    // Arrange
    const lineId = await aside();
    events.length = 0;

    // Act
    const made = await client.createTerm(lineId, { term: "MVCC", explanation: "多版本並行控制" });
    const again = await client.createTerm(lineId, { term: "VACUUM", explanation: "清死 tuple" });

    // Assert
    expect(made.keptBranch).toMatchObject({ lineId, kind: "aside" });
    expect(made.keptBranch?.keptAt).toBeTruthy();
    expect(made.term.sourceLabel).toBe("順口問・What is MVCC?");
    expect("keptBranch" in again).toBe(false);
    expect(kinds()).toEqual(["terms.changed", "branch.changed:kept", "terms.changed"]);
    expect((await client.getBranch(lineId)).branch.keptAt).toBe(made.keptBranch?.keptAt);
  });

  it("does not keep the aside when the save is refused", async () => {
    // Arrange
    const lineId = await aside();
    await client.createTerm(NAS_ROOT_ID, { term: "MVCC", explanation: "x" });

    // Act
    const refused = await rejection(client.createTerm(lineId, { term: "MVCC", explanation: "y" }));

    // Assert
    expect(refused.code).toBe("term_exists");
    expect((await client.getBranch(lineId)).branch.keptAt).toBeUndefined();
  });

  it("refuses empty and long texts, a message of another line, an archived conversation and the 301st term", async () => {
    expect(await rejection(client.createTerm(NAS_ROOT_ID, { term: " ", explanation: "x" }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "term" } });
    expect(await rejection(client.createTerm(NAS_ROOT_ID, { term: "x", explanation: "\n" }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "explanation" } });
    expect(await rejection(client.createTerm(NAS_ROOT_ID, { term: "字".repeat(61), explanation: "x" }))).toMatchObject({ status: 422, code: "too_long", extra: { field: "term", max: 60 } });
    expect(await rejection(client.createTerm(NAS_ROOT_ID, { term: "x", explanation: "字".repeat(1001) }))).toMatchObject({ status: 422, code: "too_long", extra: { field: "explanation", max: 1000 } });
    expect((await rejection(client.createTerm("nas-b3", { term: "x", explanation: "y", sourceMessageId: "nas-m17" }))).code).toBe("message_not_found");
    expect((await rejection(client.createTerm("no-such-line", { term: "x", explanation: "y" }))).code).toBe("line_not_found");

    const full = Array.from({ length: 300 }, (_, index): Term => ({ id: `t${index}`, rootLineId: NAS_ROOT_ID, term: `t${index}`, termKey: `t${index}`, explanation: "x", sourceLineId: "", sourceMessageId: "", sourceLabel: "", createdBy: "", createdAt: "", updatedAt: "" }));
    start({}, full);
    expect(await rejection(client.createTerm(NAS_ROOT_ID, { term: "one more", explanation: "x" }))).toMatchObject({ status: 409, code: "term_limit", extra: { limit: 300 } });
    // A replace of a stored term still goes through at the cap.
    expect((await client.createTerm(NAS_ROOT_ID, { term: "T0", explanation: "y", replace: true })).change).toBe("updated");

    await client.archiveLine(NAS_ROOT_ID);
    expect((await rejection(client.createTerm(NAS_ROOT_ID, { term: "x", explanation: "y" }))).code).toBe("archived");
    expect((await client.listTerms(NAS_ROOT_ID)).terms).toHaveLength(300);
  });
});

describe("mock glossary: editing, deleting, searching", () => {
  it("edits the explanation or the term, refuses an empty patch and a rename onto another term, and deletes with 204", async () => {
    // Arrange
    const mvcc = (await client.createTerm(NAS_ROOT_ID, { term: "MVCC", explanation: "old" })).term;
    const wal = (await client.createTerm(NAS_ROOT_ID, { term: "WAL", explanation: "log" })).term;

    // Act and assert
    expect((await client.updateTerm(mvcc.id, { explanation: " new " })).term).toMatchObject({ term: "MVCC", explanation: "new" });
    expect((await client.updateTerm(mvcc.id, { term: "Multi Version" })).term).toMatchObject({ term: "Multi Version", termKey: "multiversion", explanation: "new" });
    expect((await rejection(client.updateTerm(mvcc.id, {}))).code).toBe("invalid_input");
    expect(await rejection(client.updateTerm(mvcc.id, { term: "w a l" }))).toMatchObject({ code: "term_exists", extra: { term: { id: wal.id } } });
    expect(await client.deleteTerm(wal.id)).toBeUndefined();
    expect((await rejection(client.deleteTerm(wal.id))).code).toBe("term_not_found");
    expect(events.filter((event) => event.type === "terms.changed").map((event) => event.data.change)).toEqual(["created", "created", "updated", "updated", "deleted"]);
  });

  it("searches every unarchived conversation, the terms that start with the query first, with the conversation's title and pages", async () => {
    // Arrange
    const other = await client.createLine({ title: "資料庫筆記" });
    await client.createTerm(other.id, { term: "MVCC", explanation: "多版本並行控制" });
    await client.createTerm(NAS_ROOT_ID, { term: "PG MVCC", explanation: "x" });
    await client.createTerm(NAS_ROOT_ID, { term: "WAL", explanation: "y" });

    // Act
    const hits = await client.searchTerms({ q: "mv" });
    const firstPage = await client.searchTerms({ limit: 2 });
    const secondPage = await client.searchTerms({ limit: 2, cursor: firstPage.nextCursor });

    // Assert
    expect(hits.terms.map((term) => [term.term, term.rootTitle])).toEqual([
      ["MVCC", "資料庫筆記"],
      ["PG MVCC", expect.any(String)],
    ]);
    expect(hits.nextCursor).toBe("");
    expect(firstPage.terms).toHaveLength(2);
    expect(secondPage.terms.map((term) => term.term)).toEqual(["WAL"]);
    expect((await rejection(client.searchTerms({ limit: 101 }))).code).toBe("invalid_input");
    await client.archiveLine(other.id);
    expect((await client.searchTerms({ q: "mv" })).terms.map((term) => term.term)).toEqual(["PG MVCC"]);
  });

  it("answers feature_disabled for every call when the glossary is off, and exports no terms", async () => {
    start({ features: "core" });
    for (const call of [client.listTerms(NAS_ROOT_ID), client.createTerm(NAS_ROOT_ID, { term: "x", explanation: "y" }), client.updateTerm("t", { term: "x" }), client.deleteTerm("t"), client.searchTerms({ q: "x" })]) {
      expect(await rejection(call)).toMatchObject({ status: 404, code: "feature_disabled", extra: { feature: "glossary" } });
    }
    expect((await client.exportTree(NAS_ROOT_ID)).terms).toEqual([]);
  });
});

describe("mock glossary: when the tree changes", () => {
  it("keeps a deleted aside's term without a source line, and exports the tree's terms", async () => {
    // Arrange
    const lineId = await aside();
    const made = await client.createTerm(lineId, { term: "MVCC", explanation: "多版本並行控制" });

    // Act
    await client.deleteBranch(lineId);

    // Assert
    const [term] = (await client.listTerms(NAS_ROOT_ID)).terms;
    expect(term).toMatchObject({ id: made.term.id, sourceLineId: "", sourceLabel: "順口問・What is MVCC?" });
    expect((await client.exportTree(NAS_ROOT_ID)).terms.map((item) => item.term)).toEqual(["MVCC"]);
  });

  it("moves a continued aside's term to the branch it became", async () => {
    // Arrange
    const lineId = await aside();
    await client.createTerm(lineId, { term: "MVCC", explanation: "多版本並行控制" });

    // Act
    const continued = await client.continueAside(lineId);

    // Assert
    expect((await client.listTerms(NAS_ROOT_ID)).terms[0]).toMatchObject({ sourceLineId: continued.line.id });
  });

  it("drops a conversation's terms with it, and an attached conversation keeps the target's term where both have one", async () => {
    // Arrange
    const target = await client.createLine({ title: "target" });
    const source = await client.importConversation({ title: "source", provider: "fake", model: "fake-1", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] });
    await client.importConversation({ title: "t", provider: "fake", model: "fake-1", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] });
    const kept = await client.createTerm(target.id, { term: "MVCC", explanation: "the target's" });
    await client.createTerm(source.line.id, { term: "mvcc", explanation: "the source's" });
    await client.createTerm(source.line.id, { term: "WAL", explanation: "moves over" });
    await client.sendMessage(target.id, { content: "hello" });
    await vi.runAllTimersAsync();

    // Act
    await client.attachLine(target.id, { sourceLineId: source.line.id });

    // Assert
    expect((await client.listTerms(target.id)).terms.map((term) => [term.term, term.explanation])).toEqual([
      ["MVCC", "the target's"],
      ["WAL", "moves over"],
    ]);
    expect((await client.listTerms(target.id)).terms[0]!.id).toBe(kept.term.id);
    await client.deleteLine(target.id);
    expect((await client.searchTerms({ q: "wal" })).terms).toEqual([]);
  });
});
