import { afterEach, describe, expect, it } from "vitest";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import type { Message } from "../types";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";

let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function setup() {
  const events: TangentEvent[] = [];
  client = createMockTangentClient({ scenario: nasScenario({ features: "all" }), latencyMs: 0, chunkMs: 1, draftMs: 1 });
  client.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  return { c: client, events };
}

const code = async (promise: Promise<unknown>) => promise.then(() => "", (error: unknown) => (error instanceof TangentError ? error.code : String(error)));

async function chat(c: MockTangentClient, lineId: string): Promise<Message[]> {
  return (await c.listMessages(lineId)).messages.filter((message) => message.kind === "chat" && message.role !== "system" && message.status === "done");
}

describe("mock relation kinds (B15)", () => {
  it("defaults to related, keeps a given kind and refuses an unknown one", async () => {
    const { c } = setup();
    const plain = await c.createRelation(NAS_ROOT_ID, { toLineId: "osaka" });
    expect(plain.relation.relationKind).toBe("related");
    const against = await c.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", relationKind: "contradicts" });
    expect(against.relation.relationKind).toBe("contradicts");
    expect(await code(c.createRelation(NAS_ROOT_ID, { toLineId: "rust", relationKind: "Contradicts" as never }))).toBe("invalid_input");
    const listed = await c.listRelations(NAS_ROOT_ID);
    expect(listed.relations.map((relation) => relation.relationKind).sort()).toEqual(["contradicts", "related"]);
  });

  it("edits the label and the kind apart; a field left out keeps its value and an empty kind is refused", async () => {
    const { c, events } = setup();
    const made = await c.createRelation(NAS_ROOT_ID, { toLineId: "osaka", label: "Same trip" });
    const kind = await c.updateRelation(NAS_ROOT_ID, made.relation.id, { relationKind: "depends_on" });
    expect(kind.relation).toMatchObject({ label: "Same trip", relationKind: "depends_on" });
    const label = await c.updateRelation(NAS_ROOT_ID, made.relation.id, { label: "Osaka first" });
    expect(label.relation).toMatchObject({ label: "Osaka first", relationKind: "depends_on" });
    expect(await code(c.updateRelation(NAS_ROOT_ID, made.relation.id, { relationKind: "" as never }))).toBe("invalid_input");
    expect(events.filter((event) => event.type === "link.changed").length).toBeGreaterThanOrEqual(3);
  });
});

describe("mock tag drafts (B15)", () => {
  it("puts a type back as AI's draft and lists the tree's drafts, main line first", async () => {
    const { c } = setup();
    const [main] = await chat(c, NAS_ROOT_ID);
    const [branch] = await chat(c, "nas-b1a");
    await c.tagMessage(branch!.id, { kind: "idea", status: "draft" });
    const back = await c.tagMessage(main!.id, { kind: "decision", status: "draft" });
    expect(back.message.tag).toMatchObject({ kind: "decision", source: "ai", status: "draft" });
    const fromBranch = await c.listTagDrafts("nas-b1a");
    expect(fromBranch.rootLineId).toBe(NAS_ROOT_ID);
    const ids = fromBranch.drafts.map((draft) => draft.messageId);
    expect(ids.indexOf(main!.id)).toBeLessThan(ids.indexOf(branch!.id));
    expect(fromBranch.drafts.find((draft) => draft.messageId === branch!.id)).toMatchObject({ lineId: "nas-b1a", tag: { kind: "idea", status: "draft" } });
    const confirmed = await c.tagMessage(main!.id, { kind: "decision" });
    expect(confirmed.message.tag).toMatchObject({ source: "user", status: "confirmed" });
    expect((await c.listTagDrafts(NAS_ROOT_ID)).drafts.some((draft) => draft.messageId === main!.id)).toBe(false);
  });

  it("cuts each draft's text and leaves discarded branches out", async () => {
    const { c } = setup();
    const [branch] = await chat(c, "nas-b3");
    await c.tagMessage(branch!.id, { kind: "pro", status: "draft" });
    const listed = await c.listTagDrafts(NAS_ROOT_ID);
    for (const draft of listed.drafts) expect(Array.from(draft.content).length).toBeLessThanOrEqual(200);
    await c.discardBranch("nas-b3");
    expect((await c.listTagDrafts(NAS_ROOT_ID)).drafts.some((draft) => draft.lineId === "nas-b3")).toBe(false);
  });

  it("refuses an unknown status", async () => {
    const { c } = setup();
    const [main] = await chat(c, NAS_ROOT_ID);
    expect(await code(c.tagMessage(main!.id, { kind: "idea", status: "maybe" as never }))).toBe("invalid_input");
  });
});
