/** The mock's B10 phase A simulation: argument tags and folds behave like the server's (docs/devlog/B10-p3.md). */
import { afterEach, describe, expect, it } from "vitest";
import type { FeatureMode } from "../capabilities";
import { TangentError } from "../errors";
import type { TangentEvent } from "../events";
import { createMockTangentClient, NAS_ROOT_ID, nasScenario, type MockTangentClient } from "./index";
import { FOLD_SUMMARY_TEXT } from "./mock-p3";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let client: MockTangentClient | null = null;
afterEach(() => client?.mock.dispose());

function make(modes: Readonly<Record<string, FeatureMode>> = {}) {
  const scenario = nasScenario();
  scenario.capabilities = {
    ...scenario.capabilities,
    features: scenario.capabilities.features.map((feature) => {
      const mode = modes[feature.name];
      if (mode === undefined) return feature;
      return mode === "off" ? { name: feature.name, enabled: false } : { ...feature, enabled: true, mode };
    }),
  };
  const events: TangentEvent[] = [];
  const made = createMockTangentClient({ scenario, chunkMs: 1, draftMs: 1 });
  made.subscribe({ handlers: {}, onEvent: (event) => events.push(event) });
  client = made;
  return { client: made, events };
}

async function rejection(promise: Promise<unknown>): Promise<TangentError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(TangentError);
  return error as TangentError;
}

async function turn(c: MockTangentClient, lineId: string, content: string): Promise<void> {
  await c.sendMessage(lineId, { content });
  for (let i = 0; i < 500 && (await c.getLine(lineId)).status === "thinking"; i += 1) await sleep(2);
}

const chatOf = async (c: MockTangentClient, lineId: string) => (await c.listMessages(lineId)).messages.filter((message) => message.kind === "chat" && message.role !== "system");

describe("argument tags (ibis)", () => {
  it("the user's tag: set, changed and cleared, with message.updated only when it changes", async () => {
    const { client: c, events } = make({ ibis: "manual" });
    const tagged = await c.tagMessage("nas-m17", { kind: "decision" });
    expect(tagged.message.tag).toMatchObject({ kind: "decision", source: "user", status: "confirmed" });
    await c.tagMessage("nas-m17", { kind: "decision" });
    expect(events.filter((event) => event.type === "message.updated")).toHaveLength(1);
    expect((await c.untagMessage("nas-m17")).message.tag).toBeUndefined();
    await c.untagMessage("nas-m17");
    expect(events.filter((event) => event.type === "message.updated")).toHaveLength(2);
    expect((await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.id === "nas-m17")?.tag).toBeUndefined();
  });

  it("refuses what cannot be tagged, and a turned-off feature", async () => {
    const { client: c } = make({ ibis: "manual" });
    const card = (await c.listMessages(NAS_ROOT_ID)).messages.find((message) => message.kind === "branch_card")!;
    expect((await rejection(c.tagMessage(card.id, { kind: "idea" }))).code).toBe("invalid_input");
    expect((await rejection(c.tagMessage("nope", { kind: "idea" }))).code).toBe("message_not_found");
    const off = make({ ibis: "off" }).client;
    expect((await rejection(off.tagMessage("nas-m17", { kind: "idea" }))).code).toBe("feature_disabled");
  });

  it("suggest: after a turn AI drafts tags (question / idea) on untagged messages and never replaces one", async () => {
    const { client: c } = make({ ibis: "suggest" });
    const before = await chatOf(c, NAS_ROOT_ID);
    await c.tagMessage(before.at(-1)!.id, { kind: "con" });
    await turn(c, NAS_ROOT_ID, "And the UPS?");
    await sleep(10);
    const after = await chatOf(c, NAS_ROOT_ID);
    expect(after.at(-2)?.tag).toMatchObject({ kind: "question", source: "ai", status: "draft" });
    expect(after.at(-1)?.tag).toMatchObject({ kind: "idea", source: "ai", status: "draft" });
    expect(after.find((message) => message.id === before.at(-1)!.id)?.tag).toMatchObject({ kind: "con", source: "user" });
  });

  it("[fake:job-error] makes the tagging job fail with job.failed", async () => {
    const { client: c, events } = make({ ibis: "suggest" });
    await turn(c, NAS_ROOT_ID, "[fake:job-error] tag this");
    await sleep(10);
    expect(events.find((event) => event.type === "job.failed")?.data).toMatchObject({ kind: "ibis_tag" });
    expect((await chatOf(c, NAS_ROOT_ID)).at(-1)?.tag).toBeUndefined();
  });

  it("a branch carries its fork message's tag (anchorTag)", async () => {
    const { client: c } = make({ ibis: "manual" });
    await c.tagMessage("nas-m17", { kind: "question" });
    const branch = (await c.listBranches(NAS_ROOT_ID)).branches.find((item) => item.anchorMessageId === "nas-m17")!;
    expect(branch.anchorTag?.kind).toBe("question");
  });
});

describe("folds", () => {
  it("AI drafts the summary: drafting with a job, then active with fold.changed", async () => {
    const { client: c, events } = make({ fold: "manual" });
    const chat = await chatOf(c, NAS_ROOT_ID);
    const made = await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[3]!.id, toMessageId: chat[0]!.id });
    expect(made.fold).toMatchObject({ status: "drafting", summary: "", fromSeq: chat[0]!.seq, toSeq: chat[3]!.seq, messageCount: 4 });
    expect(made.job?.kind).toBe("fold_summary");
    await sleep(10);
    const listed = (await c.listFolds(NAS_ROOT_ID)).folds[0]!;
    expect(listed).toMatchObject({ status: "active", summary: FOLD_SUMMARY_TEXT, aiDrafted: true });
    expect(listed.tokensOriginal).toBeGreaterThan(listed.tokensSummary);
    expect(events.filter((event) => event.type === "fold.changed").length).toBeGreaterThanOrEqual(2);
  });

  it("the user's summary is active at once; overlaps, short ranges and gone folds are refused", async () => {
    const { client: c } = make({ fold: "manual" });
    const chat = await chatOf(c, NAS_ROOT_ID);
    const made = await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[3]!.id, summary: "Needs, in short" });
    expect(made).toMatchObject({ fold: { status: "active", aiDrafted: false, summary: "Needs, in short" }, job: null });
    const overlap = await rejection(c.createFold(NAS_ROOT_ID, { fromMessageId: chat[2]!.id, toMessageId: chat[5]!.id }));
    expect([overlap.code, overlap.extra.foldId]).toEqual(["fold_overlap", made.fold.id]);
    expect((await rejection(c.createFold(NAS_ROOT_ID, { fromMessageId: chat[6]!.id, toMessageId: chat[6]!.id }))).code).toBe("invalid_fold");
    await c.deleteFold(made.fold.id);
    expect((await rejection(c.deleteFold(made.fold.id))).code).toBe("fold_not_found");
    expect((await c.listFolds(NAS_ROOT_ID)).folds).toEqual([]);
  });

  it("[fake:job-error] in the range fails the draft (fold.changed failed, job.failed)", async () => {
    const { client: c, events } = make({ fold: "manual" });
    await turn(c, NAS_ROOT_ID, "[fake:job-error] fold me");
    const chat = await chatOf(c, NAS_ROOT_ID);
    await c.createFold(NAS_ROOT_ID, { fromMessageId: chat.at(-2)!.id, toMessageId: chat.at(-1)!.id });
    await sleep(10);
    expect((await c.listFolds(NAS_ROOT_ID)).folds[0]?.status).toBe("failed");
    expect(events.filter((event) => event.type === "job.failed").map((event) => (event.data as { kind: string }).kind)).toContain("fold_summary");
  });

  it("the preview sends an active fold's summary in place of its messages, and fisheye lists it as one item", async () => {
    const { client: c } = make({ fold: "manual", fisheye: "off" });
    const chat = await chatOf(c, NAS_ROOT_ID);
    const last = chat.slice(-4);
    const made = await c.createFold(NAS_ROOT_ID, { fromMessageId: last[0]!.id, toMessageId: last[1]!.id, summary: "Two messages, folded" });
    const preview = await c.previewTurn(NAS_ROOT_ID, { content: "x" });
    expect(preview.folds).toEqual([{ foldId: made.fold.id, fromSeq: last[0]!.seq, toSeq: last[1]!.seq, messages: 2, tokensOriginal: made.fold.tokensOriginal, tokensSummary: made.fold.tokensSummary }]);
    expect(preview.prompt.history.some((item) => item.role === "system" && item.content.includes("Two messages, folded"))).toBe(true);
    expect(preview.prompt.history.some((item) => item.content === last[0]!.content)).toBe(false);
    const { client: withFisheye } = make({ fold: "manual" });
    const folded = await withFisheye.createFold(NAS_ROOT_ID, { fromMessageId: last[0]!.id, toMessageId: last[1]!.id, summary: "Two messages, folded" });
    const items = (await withFisheye.previewTurn(NAS_ROOT_ID, { content: "x" })).fisheye!.items;
    expect(items.find((item) => item.kind === "fold")?.id).toBe(folded.fold.id);
    expect(items.some((item) => item.id === last[0]!.id)).toBe(false);
  });

  it("suggest: every 10 replies the oldest ended chapter (≥ 8 messages, ≥ 1000 tokens) is proposed; accepting folds it", async () => {
    const { client: c } = make({ fold: "suggest", ibis: "off" });
    const line = await c.createLine({ title: "Long" });
    const long = (n: number) => `Question ${n}: ${"the backup plan needs more detail about disks, snapshots and offsite copies; ".repeat(9)}`;
    for (let n = 1; n <= 5; n += 1) await turn(c, line.id, long(n));
    const fifth = (await chatOf(c, line.id)).at(-2)!;
    await c.addMilestone(line.id, { messageId: fifth.id, title: "Second part" });
    for (let n = 6; n <= 10; n += 1) await turn(c, line.id, `Short ${n}`);
    await sleep(10);
    const proposal = (await c.listSuggestions(line.id)).suggestions.find((item) => item.feature === "fold")!;
    expect(proposal.payload).toMatchObject({ messageCount: 8, summary: FOLD_SUMMARY_TEXT });
    const accepted = await c.acceptSuggestion(proposal.id);
    expect(accepted.result).toMatchObject({ fold: { status: "active", messageCount: 8, aiDrafted: true } });
    await c.dismissSuggestion(proposal.id).catch(() => undefined);
  });

  it("[fake:fold-suggest] (mock only, for the demo and e2e) proposes folding the line's oldest messages at once", async () => {
    const { client: c } = make({ fold: "suggest", ibis: "off" });
    await turn(c, NAS_ROOT_ID, "[fake:fold-suggest] tidy up");
    await sleep(10);
    const proposal = (await c.listSuggestions(NAS_ROOT_ID)).suggestions.find((item) => item.feature === "fold");
    const chat = await chatOf(c, NAS_ROOT_ID);
    expect(proposal?.payload).toMatchObject({ fromMessageId: chat[0]!.id, toMessageId: chat[3]!.id, messageCount: 4 });
  });
});

