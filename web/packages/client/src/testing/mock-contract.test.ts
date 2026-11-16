/**
 * The mock client must answer with the server's wire shapes: every raw body
 * it produces (before normalization, which would hide a missing field) is
 * compared with the matching contract sample, key for key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { routeSample, routeSampleNames, shapeDiff } from "../contract-samples";
import { createMockTangentClient, NAS_ROOT_ID, type MockTangentClient } from "./index";

/** Routes the mock does not simulate (none since F4). Error envelopes are not compared. */
const NOT_SIMULATED = new Set<string>();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The mock's route labels (the `inspect` names) and the route each one answers. */
const MOCK_ROUTES: Record<string, string> = {
  capabilities: "GET /capabilities",
  "lines.list": "GET /lines",
  "lines.create": "POST /lines",
  "lines.get": "GET /lines/{id}",
  "lines.update": "PATCH /lines/{id}",
  "lines.delete": "DELETE /lines/{id}",
  "lines.archive": "POST /lines/{id}/archive",
  "lines.unarchive": "POST /lines/{id}/unarchive",
  "lines.read": "POST /lines/{id}/read",
  "messages.list": "GET /lines/{id}/messages",
  "messages.send": "POST /lines/{id}/messages",
  retry: "POST /lines/{id}/retry",
  stream: "GET /lines/{id}/stream",
  cancel: "POST /lines/{id}/cancel",
  compact: "POST /lines/{id}/compact",
  preview: "POST /lines/{id}/preview",
  "branches.list": "GET /lines/{id}/branches",
  "branches.create": "POST /lines/{id}/branches",
  "branches.move": "POST /lines/{id}/branches/move",
  "branch.promote": "POST /lines/{id}/branch/promote",
  "branch.get": "GET /lines/{id}/branch",
  "branch.rename": "PATCH /lines/{id}/branch",
  "branches.preview": "POST /lines/{id}/branches/preview",
  search: "GET /search",
  "branch.draft": "POST /lines/{id}/branch/draft",
  "branch.merge": "POST /lines/{id}/branch/merge",
  "branch.discard": "POST /lines/{id}/branch/discard",
  "notes.list": "GET /lines/{id}/notes",
  "notes.create": "POST /lines/{id}/notes",
  "notes.update": "PATCH /lines/{id}/notes/{id}",
  "notes.supersede": "POST /lines/{id}/notes/{id}/supersede",
  "chapters.list": "GET /lines/{id}/chapters",
  "chapters.milestones.add": "POST /lines/{id}/chapters/milestones",
  "chapters.milestones.delete": "DELETE /lines/{id}/chapters/milestones/{id}",
  // B8 phase A.
  "leaf.get": "GET /lines/{id}/leaf",
  "leaf.put": "PUT /lines/{id}/leaf",
  "leaf.delete": "DELETE /lines/{id}/leaf",
  "leaf.draft": "POST /lines/{id}/leaf/draft",
  "seeds.list": "GET /lines/{id}/seeds",
  "seeds.create": "POST /lines/{id}/seeds",
  "seeds.expand": "POST /seeds/{id}/expand",
  "seeds.to_note": "POST /seeds/{id}/to-note",
  "seeds.drop": "POST /seeds/{id}/drop",
  "suggestions.list": "GET /lines/{id}/suggestions",
  "suggestions.accept": "POST /suggestions/{id}/accept",
  "suggestions.dismiss": "POST /suggestions/{id}/dismiss",
  // B8 phase B.
  spinoff: "POST /lines/{id}/spinoff",
  "spinoff.preview": "POST /lines/{id}/spinoff/preview",
  "links.list": "GET /lines/{id}/links",
  // B9 phase A.
  "goal.get": "GET /lines/{id}/goal",
  "goal.put": "PUT /lines/{id}/goal",
  "goal.delete": "DELETE /lines/{id}/goal",
  "goal.propose": "POST /lines/{id}/goal/propose",
  "relations.list": "GET /lines/{id}/relations",
  "relations.create": "POST /lines/{id}/relations",
  "relations.delete": "DELETE /lines/{id}/relations/{id}",
  "open_loops.list": "GET /open-loops",
  "messages.pin": "POST /messages/{id}/pin",
  "messages.unpin": "DELETE /messages/{id}/pin",
  // B9 phase C.
  "relations.update": "PATCH /lines/{id}/relations/{id}",
  "groups.list": "GET /lines/{id}/groups",
  "groups.create": "POST /lines/{id}/groups",
  "groups.get": "GET /groups/{id}",
  "groups.rename": "PATCH /groups/{id}",
  "groups.dissolve": "POST /groups/{id}/dissolve",
  "groups.summarize": "POST /groups/{id}/summarize",
  "branches.combine": "POST /lines/{id}/branches/combine",
  // B10 phase A.
  "messages.tag": "PUT /messages/{id}/tag",
  "messages.untag": "DELETE /messages/{id}/tag",
  "folds.list": "GET /lines/{id}/folds",
  "folds.create": "POST /lines/{id}/folds",
  "folds.delete": "DELETE /folds/{id}",
  // B10 phase B.
  "folds.update": "PATCH /folds/{id}",
  diverge: "POST /lines/{id}/diverge",
  converge: "POST /lines/{id}/converge",
  "comparisons.list": "GET /lines/{id}/comparisons",
  "comparisons.get": "GET /comparisons/{id}",
  "comparisons.decide": "POST /comparisons/{id}/decide",
  // B10 phase C.
  "memories.list": "GET /memories",
  "memories.create": "POST /memories",
  "memories.update": "PATCH /memories/{id}",
  "memories.supersede": "POST /memories/{id}/supersede",
  "memories.search": "POST /memories/search",
  // B13.
  "memos.list": "GET /lines/{id}/memos",
  "memos.list.node": "GET /lines/{id}/memos",
  "memos.create": "POST /lines/{id}/memos",
  "memos.update": "PATCH /memos/{id}",
  "memos.delete": "DELETE /memos/{id}",
  // B14.
  "lines.export": "GET /lines/{id}/export",
  "diverge.models": "POST /lines/{id}/diverge/models",
  "seeds.batch": "POST /lines/{id}/seeds/batch",
  // B15.
  "ibis.drafts": "GET /lines/{id}/tag-drafts",
  // B17.
  "suggestions.dismiss.all": "POST /lines/{id}/suggestions/dismiss-all",
  "branch.card.update": "PATCH /lines/{id}/branch/card",
  // B18.
  "lines.import": "POST /lines/import",
  "lines.folders.rename": "POST /lines/folders/rename",
  "branches.extract": "POST /lines/{id}/branches/extract",
  "lines.decompose": "GET /lines/{id}/decompose",
  // B18.1.
  "lines.organization": "GET /lines/organization",
  // B20.
  "lines.attach": "POST /lines/{id}/attach",
  // B22.
  "lines.import_analyze": "POST /lines/import-analyze",
  // B23.
  "branch.keep": "PUT /lines/{id}/branch/keep",
  "branch.continue": "POST /lines/{id}/branch/continue",
  "branch.delete": "DELETE /lines/{id}/branch",
  // B24.
  "terms.list": "GET /lines/{id}/terms",
  "terms.create": "POST /lines/{id}/terms",
  "terms.update": "PATCH /terms/{id}",
  "terms.delete": "DELETE /terms/{id}",
  "terms.search": "GET /terms",
  // B25.
  "imports.list": "GET /imports",
  "imports.delete": "DELETE /imports/{id}",
};

/**
 * Keys the server sends only sometimes (`omitempty`); a sample may show them on its first item or not (notes.list vs notes.list.rich).
 * A preview's `fisheye` comes only with that feature, `prompt.trailing` only when it has sections and `estimatedCostUsd` only with a
 * price (route.preview vs route.preview.fisheye); the fisheye report's shape is compared on its own below.
 * B10: a message's `tag`, a branch's `anchorTag` and a preview's `folds` come only when there is one; their shapes are compared below.
 */
const OPTIONAL_KEYS = new Set([
  "sourceLabel",
  "draftError",
  "fisheye",
  "trailing",
  "estimatedCostUsd",
  "tag",
  "anchorTag",
  "folds",
  "memories",
  "importBatchId",
  "pinnedAt",
]);
/** B14's export keys these maps by line id (the mock's ids are not the sample's): their values are compared as one list. */
const BY_LINE_KEYS = new Set(["messagesByLine", "foldsByLine"]);
function withoutOptional(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOptional);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !OPTIONAL_KEYS.has(key))
      .map(([key, item]) => [key, withoutOptional(BY_LINE_KEYS.has(key) && typeof item === "object" && item !== null ? Object.values(item).flat() : item)]),
  );
}

const routeKey = (method: string, path: string) => `${method} ${path.split("?")[0]!.replace(/^\/api/, "").replace(UUID, "{id}")}`;
/** Successful samples of routes the mock simulates. */
const comparable = () =>
  routeSampleNames()
    .map(routeSample)
    .filter((sample) => sample.status < 400 && !NOT_SIMULATED.has(routeKey(sample.method, sample.path)));

/** Every raw body per route (a route with several samples, like fresh and detach spinoffs, matches any of its calls). */
const raw = new Map<string, unknown[]>();
let client: MockTangentClient;

/** Waits on real timers (the mock's chunk timer) without fake-timer plumbing. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a line's turn has finished (the mock streams on real timers). */
async function settle(c: MockTangentClient, lineId: string): Promise<void> {
  for (let i = 0; i < 200 && (await c.getLine(lineId)).status === "thinking"; i += 1) await sleep(2);
}

/** Calls every simulated route once, the way the reference flow of contract_test.go does. */
async function exercise(c: MockTangentClient): Promise<void> {
  await c.getCapabilities();
  await c.listLines({ limit: 10 });
  const line = await c.createLine({ title: "Trip planning", provider: "fake", model: "fake-1" });
  await c.getLine(line.id);
  await c.updateLine(line.id, { title: "Trip to Kyoto" });
  await c.sendMessage(line.id, { content: "When should I go to Kyoto?" });
  await sleep(5);
  await c.getStream(line.id, 0);
  await c.listMessages(line.id, { afterSeq: 0, limit: 50 });
  await c.previewTurn(line.id, { content: "What about food?" });
  await c.cancelTurn(line.id);
  await c.sendMessage(line.id, { content: "[fake:error] fail" });
  await sleep(5);
  await c.retryTurn(line.id);
  await c.cancelTurn(line.id);
  await c.compact(line.id);
  await c.markRead(line.id);
  await c.listBranches(NAS_ROOT_ID, { includeAside: true });
  await c.moveToBranch(NAS_ROOT_ID, { count: 2, purpose: "Pick the week" });
  const created = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Compare ryokan and hotels", kind: "investigate", excerpt: "Kyoto" });
  await c.sendMessage(created.line.id, { content: "Compare them" });
  await settle(c, created.line.id);
  await c.getBranch(created.line.id);
  await c.previewBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Compare ryokan and hotels", kind: "investigate", excerpt: "Kyoto", includeLater: true });
  await c.renameBranch(created.line.id, { purpose: "Compare ryokan and business hotels" });
  await c.search({ q: "ZFS", limit: 10 });
  await c.startDraft(created.line.id);
  await sleep(5);
  const card = { question: "q", conclusion: "c", evidence: [], impact: "", openItems: [], needsDecision: [], excerpts: [] };
  const tip = (await c.getBranch(created.line.id)).parentTipMessageId;
  const merged = await c.mergeBranch(created.line.id, { card, parentTipMessageId: tip, noteChanges: [{ op: "add", section: "decided", text: "Stay one night in a ryokan" }] });
  // B17: the merged card edited, then a follow-up branch from it.
  await c.updateBranchCard(created.line.id, { card: { question: "q", conclusion: "c, edited", openItems: ["Book it"] } });
  await c.previewBranch(NAS_ROOT_ID, { anchorMessageId: merged.message.id, purpose: "Follow up", kind: "investigate" });
  const other = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Another way", kind: "alternative" });
  await c.discardBranch(other.line.id);
  const alternative = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m26", purpose: "Go in spring instead", kind: "alternative" });
  await c.promoteBranch(alternative.line.id);
  await c.listNotes(NAS_ROOT_ID);
  const note = await c.createNote(NAS_ROOT_ID, { section: "todo", text: "Book the train" });
  await c.updateNote(NAS_ROOT_ID, note.note.id, { status: "done" });
  const second = await c.createNote(NAS_ROOT_ID, { section: "todo", text: "Book a hotel" });
  await c.supersedeNote(NAS_ROOT_ID, second.note.id, { text: "Book the 9:00 train" });
  await exerciseP1(c);
  await exerciseP2(c);
  await c.listChapters(NAS_ROOT_ID);
  const milestone = await c.addMilestone(NAS_ROOT_ID, { messageId: "nas-m17", title: "Planning" });
  await c.deleteMilestone(NAS_ROOT_ID, milestone.milestone.id);
  await c.archiveLine(NAS_ROOT_ID);
  await c.unarchiveLine(NAS_ROOT_ID);
  await c.deleteLine(NAS_ROOT_ID);
}

/** B8 phase A: leaves, the parking lot and the suggestion inbox (the probe proposes on `[probe:suggest]`). */
async function exerciseP1(c: MockTangentClient): Promise<void> {
  const ended = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Check ryokan prices", kind: "investigate" });
  await c.discardBranch(ended.line.id, { leaf: { line: "Too expensive for this trip" } });
  await c.putLeaf(ended.line.id, { kind: "answer", line: "About 30,000 yen a night with dinner", body: "Cheaper midweek." });
  await c.getLeaf(ended.line.id);
  await c.startLeafDraft(ended.line.id);
  await c.deleteLeaf(ended.line.id);
  const seeds = [];
  for (const text of ["Is a rail pass worth it?", "Check the visa rules", "Maybe Osaka too"]) seeds.push(await c.createSeed(NAS_ROOT_ID, { text, anchorMessageId: "nas-m17" }));
  await c.listSeeds(NAS_ROOT_ID);
  await c.expandSeed(seeds[0]!.seed.id, {});
  await c.noteSeed(seeds[1]!.seed.id, {});
  await c.dropSeed(seeds[2]!.seed.id);
  await c.listSeeds(NAS_ROOT_ID, { status: "all" });
  for (const text of ["[probe:suggest] once", "[probe:suggest-permanent] twice"]) {
    await c.sendMessage(NAS_ROOT_ID, { content: text });
    await settle(c, NAS_ROOT_ID);
  }
  const open = await c.listSuggestions(NAS_ROOT_ID);
  await c.acceptSuggestion(open.suggestions[0]!.id, {});
  await c.dismissSuggestion(open.suggestions[1]!.id);
  // B17: whatever is still open, in one go (a new probe first, so there is one).
  await c.sendMessage(NAS_ROOT_ID, { content: "[probe:suggest] again" });
  await settle(c, NAS_ROOT_ID);
  await c.dismissAllSuggestions(NAS_ROOT_ID);
  await c.listSuggestions(NAS_ROOT_ID, { status: "all" });
  await c.previewSpinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m19", copyNotes: true });
  // B8 phase B: a fresh spinoff copying the notes, then a detach (the last spinoff call is the one compared).
  await c.spinoff(NAS_ROOT_ID, { mode: "fresh", atMessageId: "nas-m19", title: "Filesystems", copyNotes: true });
  await c.spinoff("nas-b3", { mode: "detach", title: "Disk prices" });
  await c.listLinks(NAS_ROOT_ID);
}

/** B9 phase A: the goal, relations (one across conversations), open loops and pins. */
async function exerciseP2(c: MockTangentClient): Promise<void> {
  await c.getGoal(NAS_ROOT_ID);
  await c.deleteGoal(NAS_ROOT_ID);
  await c.getGoal(NAS_ROOT_ID);
  await c.proposeGoal(NAS_ROOT_ID);
  await c.putGoal(NAS_ROOT_ID, { text: "Plan a week in Kyoto in spring" });
  await c.getGoal(NAS_ROOT_ID);
  const relation = await c.createRelation(NAS_ROOT_ID, { fromMessageId: "nas-m17", toLineId: "osaka", label: "Same trip, another city" });
  await c.listRelations(NAS_ROOT_ID);
  await c.listLinks(NAS_ROOT_ID);
  const other = await c.createRelation(NAS_ROOT_ID, { toLineId: "nas-b3", relationKind: "contradicts" });
  await c.deleteRelation(NAS_ROOT_ID, other.relation.id);
  await c.listRelations(relation.relation.fromLineId);
  await c.listOpenLoops();
  await c.listOpenLoops({ root: NAS_ROOT_ID, staleDays: 4 });
  await c.pinMessage("nas-m17");
  await c.unpinMessage("nas-m17");
  await exerciseP2c(c, relation.relation.id);
  await exerciseP3(c);
}

/** B10 phase A: tags (set, changed, cleared) and folds (AI-drafted, written, removed), and a preview that applies one. */
async function exerciseP3(c: MockTangentClient): Promise<void> {
  await c.tagMessage("nas-m17", { kind: "question" });
  await c.tagMessage("nas-m17", { kind: "decision" });
  await c.tagMessage("nas-m17", { kind: "decision", status: "draft" });
  await c.listTagDrafts(NAS_ROOT_ID);
  await c.listMessages(NAS_ROOT_ID);
  await c.listBranches(NAS_ROOT_ID);
  await c.untagMessage("nas-m17");
  const chat = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role !== "system");
  const drafted = await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[0]!.id, toMessageId: chat[3]!.id });
  await sleep(5);
  await c.createFold(NAS_ROOT_ID, { fromMessageId: chat[4]!.id, toMessageId: chat[5]!.id, summary: "Two more, folded" });
  await c.listFolds(NAS_ROOT_ID);
  await c.previewTurn(NAS_ROOT_ID, { content: "So, which one?" });
  await c.updateFold(drafted.fold.id, { summary: "Backups: offsite as well." });
  await c.deleteFold(drafted.fold.id);
  await exerciseP3b(c);
}

/** B10 phase B: diverge into three directions, compare two (with criteria), list, read and decide. */
async function exerciseP3b(c: MockTangentClient): Promise<void> {
  const anchor = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role === "assistant").at(-1)!;
  await c.diverge(NAS_ROOT_ID, { anchorMessageId: anchor.id, count: 2 });
  await sleep(5);
  const [a, b] = (await c.listBranches(NAS_ROOT_ID)).branches.filter((branch) => branch.origin === "diverge");
  const started = await c.converge(NAS_ROOT_ID, { lineIds: [a!.lineId, b!.lineId], criteria: ["Safety", "Speed"] });
  await sleep(5);
  await c.listComparisons(NAS_ROOT_ID);
  await c.getComparison(started.comparison.id);
  await c.decideComparison(started.comparison.id, { lineId: a!.lineId });
  await exerciseP3c(c);
  await exerciseMemos(c);
}

/** B13: a memo on a branch, both listings, an edit and a delete. */
async function exerciseMemos(c: MockTangentClient): Promise<void> {
  const made = await c.createMemo(NAS_ROOT_ID, { lineId: "nas-b1", text: "Ask about the router" });
  await c.listMemos(NAS_ROOT_ID);
  await c.listMemos(NAS_ROOT_ID, { lineId: "nas-b1" });
  await c.updateMemo(made.memo.id, "Ask about the router before Friday");
  await c.deleteMemo(made.memo.id);
  await exerciseB14(c);
}

/** B14: search within one tree, a diverge across the mock's two models, a batch of seeds and the whole tree. */
async function exerciseB14(c: MockTangentClient): Promise<void> {
  await c.search({ q: "ZFS", root: NAS_ROOT_ID });
  const anchor = (await c.listMessages(NAS_ROOT_ID)).messages.filter((message) => message.kind === "chat" && message.role === "assistant" && message.status === "done").at(-1)!;
  await c.divergeModels(NAS_ROOT_ID, {
    anchorMessageId: anchor.id,
    purpose: "Pick the disks",
    targets: [
      { provider: "anthropic", model: "claude-haiku-4-5" },
      { provider: "anthropic", model: "claude-sonnet-4-5", purpose: "The careful take" },
    ],
  });
  await c.createSeedsBatch(NAS_ROOT_ID, { anchorMessageId: anchor.id, texts: ["Benchmark both", "Check the warranty"] });
  await c.createMemo(NAS_ROOT_ID, { lineId: NAS_ROOT_ID, text: "Ask the shop" });
  await c.exportTree(NAS_ROOT_ID);
  await exerciseB18(c);
}

/** B18: an import with a restored re-ask, folders and tags (filters, PATCH, rename, the tenant's organization), a decompose plan and an extract with a card. */
async function exerciseB18(c: MockTangentClient): Promise<void> {
  const imported = await c.importConversation({
    title: "PostgreSQL MVCC",
    provider: "fake",
    model: "fake-1",
    folder: "Databases",
    tags: ["postgres", "#MVCC"],
    source: "chatgpt",
    messages: [
      { externalId: "m1", role: "user", content: "Explain PostgreSQL MVCC" },
      { externalId: "m2", role: "assistant", content: "Every transaction sees its own snapshot." },
      { externalId: "m3", role: "user", content: "Docker cannot reach the host Postgres: connection refused error" },
      { externalId: "m4", role: "assistant", content: "Use host.docker.internal instead. Or run the container on the host network." },
      { externalId: "m5", role: "user", content: "Back to MVCC: when does PostgreSQL VACUUM run?" },
      { externalId: "m6", role: "assistant", content: "When dead tuples pass a threshold.\n- Should autovacuum_vacuum_scale_factor change?\nWant an example?" },
    ],
    branches: [{ anchorExternalId: "m2", purpose: "Table locks instead", messages: [{ role: "user", content: "What if table locks instead?" }, { role: "assistant", content: "Reads and writes block." }] }],
  });
  await c.listLines({ tag: "postgres" });
  await c.listLines({ folder: "Databases" });
  await c.updateLine(imported.line.id, { tags: ["postgres", "mvcc", "vacuum"] });
  await c.renameFolder({ from: "Databases", to: "Storage" });
  await c.getLineOrganization();
  await c.decomposeLine(imported.line.id);
  const main = (await c.listMessages(imported.line.id)).messages;
  await c.extractBranch(imported.line.id, {
    fromMessageId: main[2]!.id,
    toMessageId: main[3]!.id,
    purpose: "Docker connection",
    kind: "investigate",
    card: { question: "Why can't the container reach Postgres?", conclusion: "Use host.docker.internal." },
  });
  await exerciseB19(c);
  await exerciseB20(c);
  await exerciseB22(c);
  await exerciseB23(c);
  await exerciseB25(c);
  await exerciseGlossary(c);
}

/** B25: batch imports (one kept via a note, one deleted), listing batches, pinning an imported line, and listing pinned lines. */
async function exerciseB25(c: MockTangentClient): Promise<void> {
  const batchId = "00000000-0000-4000-8000-0000000000b2";
  const unused = await c.importConversation({
    batchId,
    batchLabel: "conversations.json",
    title: "京都賞楓",
    provider: "fake",
    model: "fake-1",
    source: "chatgpt",
    messages: [
      { role: "user", content: "十一月去京都看楓葉適合嗎？" },
      { role: "assistant", content: "十一月中下旬是京都紅葉的高峰。" },
    ],
  });
  const used = await c.importConversation({
    batchId,
    batchLabel: "conversations.json",
    title: "大阪美食",
    provider: "fake",
    model: "fake-1",
    source: "chatgpt",
    messages: [
      { role: "user", content: "道頓堀有什麼推薦的？" },
      { role: "assistant", content: "章魚燒和串炸。" },
    ],
  });
  await c.createNote(used.line.id, { section: "decided", text: "晚餐吃串炸" });
  await c.updateLine(used.line.id, { pinned: true });
  await c.listLines({ pinned: true });
  await c.listImportBatches({ limit: 20 });
  await c.deleteImportBatch(batchId);
  expect((await c.listLines({ pinned: true })).lines.some((line) => line.id === used.line.id)).toBe(true);
  expect(unused.line.importBatchId).toBe(batchId);
}

/** B24: a term saved from an answered aside (which keeps it), one from the main line, both listings, an edit, a search and a delete. */
async function exerciseGlossary(c: MockTangentClient): Promise<void> {
  const aside = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "quick check", kind: "aside" });
  await c.sendMessage(aside.line.id, { content: "What is MVCC?" });
  await settle(c, aside.line.id);
  const made = await c.createTerm(aside.line.id, { term: "MVCC", explanation: "多版本並行控制：讀不擋寫" });
  await c.createTerm(NAS_ROOT_ID, { term: "WAL", explanation: "write-ahead log", sourceMessageId: "nas-m17" });
  await c.listTerms(NAS_ROOT_ID);
  await c.updateTerm(made.term.id, { explanation: "多版本並行控制" });
  await c.searchTerms({ q: "mv" });
  await c.deleteTerm(made.term.id);
}

/** B23: one aside kept, another continued as a branch, a third deleted (route.branch.keep / continue / delete). */
async function exerciseB23(c: MockTangentClient): Promise<void> {
  const ask = async (purpose: string) => {
    const made = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose, kind: "aside" });
    await c.sendMessage(made.line.id, { content: purpose });
    await settle(c, made.line.id);
    return made.line.id;
  };
  await c.keepBranch(await ask("quick check"), true);
  await c.continueAside(await ask("What is a connection pool?"), { purpose: "連線池的大小怎麼估" });
  await c.deleteBranch(await ask("thrown away"));
}

/** B22: the A → B → A → C → A → B analysis of route.lines.import_analyze (the mock runs the server's heuristic). */
async function exerciseB22(c: MockTangentClient): Promise<void> {
  const sample = routeSample("route.lines.import_analyze").request as Parameters<MockTangentClient["analyzeImport"]>[0];
  await c.analyzeImport(sample);
}

/** B20: a conversation imported on its own, attached to the one it belongs to with its card (route.lines.attach). */
async function exerciseB20(c: MockTangentClient): Promise<void> {
  const target = await c.importConversation({ title: "連線池調校", provider: "fake", model: "fake-1", messages: [{ role: "user", content: "PG 連線池要開多大？" }, { role: "assistant", content: "先設 20。" }] });
  const source = await c.importConversation({
    title: "PgBouncer 設定", provider: "fake", model: "fake-1", folder: "資料庫研究", tags: ["postgres"],
    messages: [{ role: "user", content: "PgBouncer 的 pool_mode 該選哪個？" }, { role: "assistant", content: "多數服務用 transaction 模式。" }],
  });
  await c.attachLine(target.line.id, { sourceLineId: source.line.id, status: "merged", card: { conclusion: "用 transaction 模式，pool size 先設 20。" } });
}

/** B19: an assembled import (route.lines.import.assembled): dates, chapter cuts and a merged branch with its card. */
async function exerciseB19(c: MockTangentClient): Promise<void> {
  await c.importConversation({
    title: "MVCC 筆記（組裝）",
    provider: "fake",
    model: "fake-1",
    source: "chatgpt",
    createdAt: "2026-01-01T00:00:00Z",
    messages: [
      { externalId: "s1-1", role: "user", content: "請解釋 PostgreSQL 的 MVCC 機制", createdAt: "2026-01-01T00:00:00Z" },
      { externalId: "s1-2", role: "assistant", content: "每個交易看到自己的快照。", createdAt: "2026-01-01T00:00:00Z" },
      { externalId: "s2-1", role: "user", content: "索引膨脹怎麼處理？", createdAt: "2026-01-01T08:00:00+08:00" },
      { externalId: "s2-2", role: "assistant", content: "用 REINDEX CONCURRENTLY 重建。" },
    ],
    branches: [
      {
        anchorExternalId: "s1-2",
        purpose: "如果改用 Table Lock 會怎樣？",
        status: "merged",
        card: { conclusion: "讀寫會互相阻塞，併發度大幅下降。", openItems: ["量測鎖等待時間"] },
        createdAt: "2026-01-01T00:00:00Z",
        messages: [
          { role: "user", content: "如果不用 MVCC 改用 Table Lock 會怎樣？" },
          { role: "assistant", content: "讀寫會互相阻塞。", createdAt: "2026-01-01T00:00:00Z" },
        ],
      },
    ],
    chapterCuts: [
      { anchorExternalId: "s1-1", title: "§1 MVCC 與 VACUUM" },
      { anchorExternalId: "s2-1", title: "§2 索引" },
    ],
  });
}

/** B10 phase C: write, list (both ways, and a page with a next one), recategorize, supersede, search, and a preview that recalls one. */
async function exerciseP3c(c: MockTangentClient): Promise<void> {
  const made = await c.createMemory({ kind: "decision", text: "The NAS uses a ZFS mirror", importance: 8, sourceLineId: NAS_ROOT_ID });
  await c.listMemories();
  await c.listMemories({ limit: 1 });
  await c.updateMemory(made.memory.id, { importance: 9, validUntil: "2030-01-01T00:00:00Z" });
  await c.supersedeMemory(made.memory.id, { text: "The NAS uses ZFS RAIDZ1" });
  await c.listMemories({ status: "superseded" });
  await c.searchMemories({ query: "Which ZFS layout for the NAS?" });
  await c.previewTurn(NAS_ROOT_ID, { content: "Should the NAS use ZFS?" });
}

/** B9 phase C: a relation's label, a group of ended branches (keepBoth note) and its life, combining two open siblings. */
async function exerciseP2c(c: MockTangentClient, relationId: string): Promise<void> {
  await c.updateRelation(NAS_ROOT_ID, relationId, { label: "Same trip, Osaka for a day" });
  await c.updateRelation(NAS_ROOT_ID, relationId, { relationKind: "supports" });
  const made = await c.createGroup(NAS_ROOT_ID, {
    memberLineIds: ["nas-b5", "nas-b4"],
    title: "Parts",
    conflicts: [{ branch: { lineId: "nas-b5", claim: "new disks" }, other: { lineId: "nas-b4", claim: "a 500W supply" }, choice: "keepBoth" }],
  });
  await sleep(5);
  await c.listGroups(NAS_ROOT_ID);
  await c.getGroup(made.group.id);
  await c.renameGroup(made.group.id, { title: "Server parts" });
  await c.summarizeGroup(made.group.id);
  await c.dissolveGroup(made.group.id);
  const a = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router A", kind: "investigate" });
  const b = await c.createBranch(NAS_ROOT_ID, { anchorMessageId: "nas-m17", purpose: "Router B", kind: "investigate" });
  await c.combineBranches(NAS_ROOT_ID, {
    lineIds: [a.line.id, b.line.id],
    purpose: "Pick the router",
    conflicts: [{ branch: { lineId: a.line.id, claim: "Wi-Fi 6 is enough" }, other: { lineId: b.line.id, claim: "Wi-Fi 7 lasts longer" }, choice: "adoptOther" }],
  });
}

beforeAll(async () => {
  client = createMockTangentClient({ chunkMs: 1, draftMs: 1, inspect: (route, body) => {
      const key = MOCK_ROUTES[route] ?? `unknown ${route}`;
      raw.set(key, [...(raw.get(key) ?? []), body]);
    } });
  await exercise(client);
  client.mock.dispose();
});

describe("mock client vs contract samples", () => {
  it("reports missing, extra and mistyped keys (the comparison itself)", () => {
    expect(shapeDiff({ a: 1, c: [{ x: "" }] }, { a: 1, b: 2, c: [{ x: 1 }] }).sort()).toEqual(["$.b: missing", "$.c[0].x: string != number"]);
    expect(shapeDiff({ a: 1, extra: true }, { a: 1 })).toEqual(["$.extra: extra"]);
    expect(shapeDiff({ meta: { anything: 1 }, closedAt: null }, { meta: {}, closedAt: "t" })).toEqual([]);
  });

  it("simulates every route a successful sample shows, except the listed ones", () => {
    const expected = [...new Set(comparable().map((sample) => routeKey(sample.method, sample.path)))].sort();
    expect(expected.filter((key) => !raw.has(key))).toStrictEqual([]);
  });

  for (const sample of comparable()) {
    it(`${sample.name}: same keys and types as the sample`, () => {
      const bodies = raw.get(routeKey(sample.method, sample.path)) ?? [];
      if (sample.response === undefined) {
        expect(bodies.at(-1)).toBeUndefined();
        return;
      }
      // The newest call's differences, unless some call of the route has the sample's shape.
      const diffs = bodies.map((body) => shapeDiff(withoutOptional(body), withoutOptional(sample.response)));
      expect(diffs.find((diff) => diff.length === 0) ?? diffs.at(-1)).toEqual([]);
    });
  }

  it("reports fisheye in the server's shape (B9 phase B: the mock's full set has the feature on)", () => {
    const previews = raw.get("POST /lines/{id}/preview") ?? [];
    const withReport = previews.find((body) => typeof body === "object" && body !== null && "fisheye" in body) as { fisheye: unknown } | undefined;
    const sample = routeSample("route.preview.fisheye").response as { fisheye: unknown };
    expect(withReport).toBeDefined();
    expect(shapeDiff(withReport!.fisheye, sample.fisheye)).toEqual([]);
  });

  it("tags, anchor tags and applied folds in the server's shape (B10 phase A)", () => {
    const tagged = (raw.get("PUT /messages/{id}/tag") ?? []).at(-1) as { message: { tag: unknown } };
    expect(shapeDiff(tagged.message.tag, (routeSample("route.messages.tag").response as { message: { tag: unknown } }).message.tag)).toEqual([]);
    const branches = (raw.get("GET /lines/{id}/branches") ?? []).flatMap((body) => (body as { branches: Array<{ anchorTag?: unknown }> }).branches);
    const sampleBranch = (routeSample("route.branches.list.anchor_tag").response as { branches: Array<{ anchorTag?: unknown }> }).branches.find((item) => item.anchorTag);
    expect(shapeDiff(branches.find((item) => item.anchorTag)?.anchorTag, sampleBranch?.anchorTag)).toEqual([]);
    const preview = (raw.get("POST /lines/{id}/preview") ?? []).find((body) => typeof body === "object" && body !== null && "folds" in body) as { folds: unknown } | undefined;
    expect(shapeDiff(preview?.folds, (routeSample("route.preview.folds").response as { folds: unknown }).folds)).toEqual([]);
    const recalled = (raw.get("POST /lines/{id}/preview") ?? []).find((body) => typeof body === "object" && body !== null && "memories" in body) as { memories: unknown } | undefined;
    expect(shapeDiff(recalled?.memories, (routeSample("route.preview.memories").response as { memories: unknown }).memories)).toEqual([]);
  });

  it("labels a note's source when it writes one, as the server does (B8 sourceLabel)", () => {
    const listed = raw.get("GET /lines/{id}/notes")?.at(-1) as { notes: Array<{ sourceLineId: string; sourceLabel?: unknown }> };
    const sourced = listed.notes.filter((note) => note.sourceLineId !== "" && "sourceLabel" in note);
    expect(sourced.length).toBeGreaterThan(0);
    for (const note of sourced) expect(typeof note.sourceLabel).toBe("string");
  });

  it("carries importBatchId and pinnedAt on batched imports and pinned lines (B25)", () => {
    const batched = (raw.get("POST /lines/import") ?? []).find((body) => typeof (body as { line: { importBatchId?: unknown } }).line.importBatchId === "string");
    expect(batched).toBeDefined();
    const pinned = (raw.get("GET /lines") ?? []).find((body) =>
      (body as { lines: Array<{ pinnedAt?: unknown; importBatchId?: unknown }> }).lines.some(
        (line) => typeof line.pinnedAt === "string" && typeof line.importBatchId === "string",
      ),
    );
    expect(pinned).toBeDefined();
  });
});
