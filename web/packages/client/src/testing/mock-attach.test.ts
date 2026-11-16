/** The mock's B20 route behaves as the server's (store/attach.go, docs/API.md `POST /lines/{id}/attach`). */
import { afterEach, describe, expect, it } from "vitest";
import { classifyAttachError } from "../b20-routes";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "./index";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function make() {
  const events: TangentEvent[] = [];
  const made = createMockTangentClient({ chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TangentError);
  const failure = error as TangentError;
  return { status: failure.status, code: failure.code, extra: failure.extra };
};

/** A target dated 09:00–09:03 and a source that started at 09:01:30 with a branch of its own. */
async function pair(c: MockTangentClient, sourceTitle = "PgBouncer") {
  const target = await c.importConversation({
    title: "Pool tuning",
    messages: [
      { role: "user", content: "How big a pool?", createdAt: "2025-03-01T09:00:00Z" },
      { role: "assistant", content: "Start with 20.", createdAt: "2025-03-01T09:01:00Z" },
      { role: "user", content: "Timeouts?", createdAt: "2025-03-01T09:02:00Z" },
      { role: "assistant", content: "30 seconds.", createdAt: "2025-03-01T09:03:00Z" },
    ],
  });
  const source = await c.importConversation({
    title: sourceTitle,
    folder: "DB",
    tags: ["pgbouncer"],
    createdAt: "2025-03-01T09:01:30Z",
    messages: [
      { externalId: "p1", role: "user", content: "Which pool_mode?" },
      { externalId: "p2", role: "assistant", content: "transaction" },
    ],
    branches: [{ anchorExternalId: "p2", purpose: "Session mode", status: "open", messages: [{ role: "user", content: "Session?" }, { role: "assistant", content: "Rarely." }] }],
  });
  return { target: target.line, source: source.line, child: source.branches[0]! };
}

describe("attach", () => {
  it("hangs the source, with its tree, on the reply before it started and takes it off the main line list", async () => {
    const { client: c, events } = make();
    const { target, source, child } = await pair(c);
    const messages = (await c.listMessages(target.id)).messages;
    await c.createNote(source.id, { section: "fact", text: "transaction mode" });
    events.length = 0;
    const out = await c.attachLine(target.id, { sourceLineId: source.id });
    expect(out.branch).toMatchObject({ lineId: source.id, parentLineId: target.id, rootLineId: target.id, anchorMessageId: messages[1]!.id, depth: 1, status: "open", origin: "move", purpose: "PgBouncer" });
    expect(out.branchLine).toMatchObject({ folder: "", tags: [], conversationBranch: { rootLineId: target.id, depth: 1 } });
    expect(out.cardMessage).toBeNull();
    expect(out.reparented).toEqual([child.lineId]);
    const tree = (await c.listBranches(target.id)).branches;
    expect(tree.find((branch) => branch.lineId === child.lineId)).toMatchObject({ rootLineId: target.id, depth: 2 });
    expect((await c.listLines()).lines.map((line) => line.id)).not.toContain(source.id);
    expect((await c.listMessages(source.id)).messages.map((message) => message.content)).toEqual(["Which pool_mode?", "transaction"]);
    expect((await c.listNotes(target.id)).notes.map((note) => note.text)).toContain("transaction mode");
    const types = events.map((event) => `${event.type}${event.type === "branch.changed" ? `:${(event.data as { change: string }).change}` : ""}`);
    expect(types).toEqual(expect.arrayContaining(["line.updated", "branch.changed:created", "branch.changed:moved", "notes.changed"]));
  });

  it("brings the source back with its card at the end of the line, already delivered", async () => {
    const { client: c } = make();
    const { target, source } = await pair(c, "");
    const out = await c.attachLine(target.id, { sourceLineId: source.id, status: "merged", card: { conclusion: "transaction mode" } });
    expect(out.branch).toMatchObject({ status: "merged", cardMessageId: out.cardMessage?.id, purpose: "Which pool_mode?" });
    expect(out.cardMessage).toMatchObject({ kind: "branch_card", meta: { delivered: true, branchLineId: source.id, card: { question: "Which pool_mode?", conclusion: "transaction mode" } } });
    expect((await c.listMessages(target.id)).messages.at(-1)?.id).toBe(out.cardMessage?.id);
  });

  it("picks the newest message when the source started after the whole line", async () => {
    const { client: c } = make();
    const target = (await c.importConversation({ title: "t", messages: [{ role: "user", content: "q", createdAt: "2025-01-01T00:00:00Z" }, { role: "assistant", content: "a", createdAt: "2025-01-01T00:01:00Z" }] })).line;
    const source = (await c.importConversation({ title: "later", messages: [{ role: "user", content: "q2" }, { role: "assistant", content: "a2" }] })).line;
    const last = (await c.listMessages(target.id)).messages.at(-1)!;
    expect((await c.attachLine(target.id, { sourceLineId: source.id })).branch.anchorMessageId).toBe(last.id);
  });

  it("refuses with the server's codes and statuses", async () => {
    const { client: c } = make();
    const { target, source, child } = await pair(c);
    expect(await refusal(c.attachLine(target.id, { sourceLineId: "" }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "sourceLineId" } });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: target.id }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "sourceLineId" } });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: child.lineId }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "sourceLineId" } });
    expect(await refusal(c.attachLine(child.lineId, { sourceLineId: source.id }))).toMatchObject({ status: 400, code: "invalid_input" });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: "nope" }))).toMatchObject({ status: 404, code: "line_not_found" });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: source.id, status: "merged" }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "card" } });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: source.id, card: { conclusion: "c" } }))).toMatchObject({ status: 400, code: "invalid_input", extra: { field: "card" } });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: source.id, status: "merged", card: { conclusion: " " } }))).toMatchObject({ status: 422, code: "invalid_card" });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: source.id, kind: "aside" as "investigate" }))).toMatchObject({ status: 400, code: "kind_unsupported" });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: source.id, anchorMessageId: "nope" }))).toMatchObject({ status: 404, code: "anchor_not_found" });
    const empty = await c.createLine({ title: "empty" });
    expect(await refusal(c.attachLine(target.id, { sourceLineId: empty.id }))).toMatchObject({ status: 400, code: "invalid_input" });
    expect(await refusal(c.attachLine(empty.id, { sourceLineId: source.id }))).toMatchObject({ status: 400, code: "move_no_anchor" });
    await c.archiveLine(NAS_ROOT_ID);
    expect(await refusal(c.attachLine(target.id, { sourceLineId: NAS_ROOT_ID }))).toMatchObject({ status: 409, code: "archived" });
  });

  it("classifies the refusals for the dialog", () => {
    expect(classifyAttachError(new TangentError(400, "x", "invalid_input", { field: "sourceLineId" }))).toEqual({ kind: "notMainLine" });
    expect(classifyAttachError(new TangentError(409, "x", "branch_busy"))).toEqual({ kind: "busy" });
    expect(classifyAttachError(new TangentError(409, "x", "depth_soft_limit", { depth: 5 }))).toEqual({ kind: "deeper", depth: 5 });
    expect(classifyAttachError(new TangentError(409, "x", "tree_limit"))).toEqual({ kind: "limit" });
    expect(classifyAttachError(new TangentError(400, "x", "move_no_anchor"))).toEqual({ kind: "noAnchor" });
    expect(classifyAttachError(new Error("boom")).kind).toBe("other");
  });
});
