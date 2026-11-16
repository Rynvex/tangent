/**
 * Contract tests (F1): every sample the Go side writes to
 * `httpapi/testdata/contract/` goes through the real client. Route samples:
 * the client must send the sample's method, path, headers and body, and its
 * normalized result must equal the sample's response strictly, key for key
 * (the samples are real server output, so nothing may be added or dropped).
 * Samples are matched to client calls by method and path, so a new sample of
 * a known route is checked without a code change and a sample of an unknown
 * route fails. Event samples: `parseEvent` must return the envelope unchanged.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createTangentClient, type TangentClient } from "./api";
import { eventSample, eventSampleNames, pathIds, routeSample, routeSampleNames, sampleNames, type RouteSample } from "./contract-samples";
import { ALL_ERROR_CODES, TangentError } from "./errors";
import { parseEvent } from "./events";

type Call = (client: TangentClient, ids: string[], request: never, query: URLSearchParams) => Promise<unknown>;

const num = (query: URLSearchParams, key: string) => (query.has(key) ? Number(query.get(key)) : undefined);
const flag = (query: URLSearchParams, key: string) => (query.has(key) ? query.get(key) === "true" : undefined);

/** One client call per route, keyed by "METHOD path" with `{id}` for every UUID and without the query. */
const ROUTES: Record<string, Call> = {
  "GET /capabilities": (c) => c.getCapabilities(),
  "GET /lines": (c, _ids, _body, q) =>
    c.listLines({
      ...(q.has("limit") ? { limit: num(q, "limit")! } : {}),
      ...(q.has("archived") ? { archived: flag(q, "archived")! } : {}),
      ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}),
      ...(q.has("folder") ? { folder: q.get("folder")! } : {}),
      ...(q.has("tag") ? { tag: q.get("tag")! } : {}),
      ...(q.has("pinned") ? { pinned: flag(q, "pinned")! } : {}),
    }),
  "POST /lines": (c, _ids, body) => c.createLine(body),
  "GET /lines/{id}": (c, [id]) => c.getLine(id!),
  "PATCH /lines/{id}": (c, [id], body) => c.updateLine(id!, body),
  "DELETE /lines/{id}": (c, [id]) => c.deleteLine(id!),
  "POST /lines/{id}/archive": (c, [id]) => c.archiveLine(id!),
  "POST /lines/{id}/unarchive": (c, [id]) => c.unarchiveLine(id!),
  "POST /lines/{id}/read": (c, [id]) => c.markRead(id!),
  "GET /lines/{id}/messages": (c, [id], _body, q) =>
    c.listMessages(id!, { ...(q.has("afterSeq") ? { afterSeq: num(q, "afterSeq")! } : {}), ...(q.has("limit") ? { limit: num(q, "limit")! } : {}) }),
  "POST /lines/{id}/messages": (c, [id], body) => c.sendMessage(id!, body),
  "POST /lines/{id}/retry": (c, [id]) => c.retryTurn(id!),
  "GET /lines/{id}/stream": (c, [id], _body, q) => c.getStream(id!, num(q, "afterSeq")),
  "POST /lines/{id}/cancel": (c, [id]) => c.cancelTurn(id!),
  "POST /lines/{id}/compact": (c, [id]) => c.compact(id!),
  "POST /lines/{id}/preview": (c, [id], body) => c.previewTurn(id!, body),
  "GET /lines/{id}/branches": (c, [id], _body, q) => c.listBranches(id!, q.has("includeAside") ? { includeAside: flag(q, "includeAside")! } : {}),
  "POST /lines/{id}/branches": (c, [id], body) => c.createBranch(id!, body),
  "POST /lines/{id}/branches/move": (c, [id], body) => c.moveToBranch(id!, body),
  "GET /lines/{id}/branch": (c, [id]) => c.getBranch(id!),
  "PATCH /lines/{id}/branch": (c, [id], body) => c.renameBranch(id!, body),
  "POST /lines/{id}/branches/preview": (c, [id], body) => c.previewBranch(id!, body),
  "GET /search": (c, _ids, _body, q) =>
    c.search({
      q: q.get("q") ?? "",
      ...(q.has("limit") ? { limit: num(q, "limit")! } : {}),
      ...(q.has("archived") ? { archived: flag(q, "archived")! } : {}),
      ...(q.has("root") ? { root: q.get("root")! } : {}),
    }),
  "POST /lines/{id}/branch/draft": (c, [id]) => c.startDraft(id!),
  "POST /lines/{id}/branch/merge": (c, [id], body) => c.mergeBranch(id!, body),
  "POST /lines/{id}/branch/discard": (c, [id], body) => c.discardBranch(id!, body),
  "POST /lines/{id}/branch/promote": (c, [id]) => c.promoteBranch(id!),
  "GET /lines/{id}/notes": (c, [id]) => c.listNotes(id!),
  "POST /lines/{id}/notes": (c, [id], body) => c.createNote(id!, body),
  "PATCH /lines/{id}/notes/{id}": (c, [id, nid], body) => c.updateNote(id!, nid!, body),
  "POST /lines/{id}/notes/{id}/supersede": (c, [id, nid], body) => c.supersedeNote(id!, nid!, body),
  "GET /lines/{id}/chapters": (c, [id]) => c.listChapters(id!),
  "POST /lines/{id}/chapters/milestones": (c, [id], body) => c.addMilestone(id!, body),
  "DELETE /lines/{id}/chapters/milestones/{id}": (c, [id, mid]) => c.deleteMilestone(id!, mid!),
  // B8 phase A.
  "GET /lines/{id}/leaf": (c, [id]) => c.getLeaf(id!),
  "PUT /lines/{id}/leaf": (c, [id], body) => c.putLeaf(id!, body),
  "DELETE /lines/{id}/leaf": (c, [id]) => c.deleteLeaf(id!),
  "POST /lines/{id}/leaf/draft": (c, [id]) => c.startLeafDraft(id!),
  "GET /lines/{id}/seeds": (c, [id], _body, q) => c.listSeeds(id!, q.has("status") ? { status: q.get("status")! } : {}),
  "POST /lines/{id}/seeds": (c, [id], body) => c.createSeed(id!, body),
  "POST /seeds/{id}/expand": (c, [id], body) => c.expandSeed(id!, body),
  "POST /seeds/{id}/to-note": (c, [id], body) => c.noteSeed(id!, body),
  "POST /seeds/{id}/drop": (c, [id]) => c.dropSeed(id!),
  "GET /lines/{id}/suggestions": (c, [id], _body, q) => c.listSuggestions(id!, q.has("status") ? { status: q.get("status")! } : {}),
  "POST /suggestions/{id}/accept": (c, [id], body) => c.acceptSuggestion(id!, body),
  "POST /suggestions/{id}/dismiss": (c, [id]) => c.dismissSuggestion(id!),
  // B8 phase B (read in F4 phase 1, used in phase 2).
  "POST /lines/{id}/spinoff": (c, [id], body) => c.spinoff(id!, body),
  "GET /lines/{id}/links": (c, [id]) => c.listLinks(id!),
  "POST /lines/{id}/spinoff/preview": (c, [id], body) => c.previewSpinoff(id!, body),
  // B9 phase A.
  "GET /lines/{id}/goal": (c, [id]) => c.getGoal(id!),
  "PUT /lines/{id}/goal": (c, [id], body) => c.putGoal(id!, body),
  "DELETE /lines/{id}/goal": (c, [id]) => c.deleteGoal(id!),
  "POST /lines/{id}/goal/propose": (c, [id]) => c.proposeGoal(id!),
  "GET /lines/{id}/relations": (c, [id]) => c.listRelations(id!),
  "POST /lines/{id}/relations": (c, [id], body) => c.createRelation(id!, body),
  "DELETE /lines/{id}/relations/{id}": (c, [id, rid]) => c.deleteRelation(id!, rid!),
  "GET /open-loops": (c, _ids, _body, q) =>
    c.listOpenLoops({ ...(q.has("root") ? { root: q.get("root")! } : {}), ...(q.has("staleDays") ? { staleDays: num(q, "staleDays")! } : {}) }),
  "POST /messages/{id}/pin": (c, [id]) => c.pinMessage(id!),
  "DELETE /messages/{id}/pin": (c, [id]) => c.unpinMessage(id!),
  // B9 phase C.
  "PATCH /lines/{id}/relations/{id}": (c, [id, rid], body) => c.updateRelation(id!, rid!, body),
  "GET /lines/{id}/groups": (c, [id], _body, q) => c.listGroups(id!, q.has("status") ? { status: q.get("status")! } : {}),
  "POST /lines/{id}/groups": (c, [id], body) => c.createGroup(id!, body),
  "GET /groups/{id}": (c, [id]) => c.getGroup(id!),
  "PATCH /groups/{id}": (c, [id], body) => c.renameGroup(id!, body),
  "POST /groups/{id}/dissolve": (c, [id]) => c.dissolveGroup(id!),
  "POST /groups/{id}/summarize": (c, [id]) => c.summarizeGroup(id!),
  "POST /lines/{id}/branches/combine": (c, [id], body) => c.combineBranches(id!, body),
  "PUT /messages/{id}/tag": (c, [id], body) => c.tagMessage(id!, body),
  "DELETE /messages/{id}/tag": (c, [id]) => c.untagMessage(id!),
  "GET /lines/{id}/folds": (c, [id]) => c.listFolds(id!),
  "POST /lines/{id}/folds": (c, [id], body) => c.createFold(id!, body),
  "DELETE /folds/{id}": (c, [id]) => c.deleteFold(id!),
  "PATCH /folds/{id}": (c, [id], body) => c.updateFold(id!, body),
  "POST /lines/{id}/diverge": (c, [id], body) => c.diverge(id!, body),
  "POST /lines/{id}/converge": (c, [id], body) => c.converge(id!, body),
  "GET /lines/{id}/comparisons": (c, [id]) => c.listComparisons(id!),
  "GET /comparisons/{id}": (c, [id]) => c.getComparison(id!),
  "POST /comparisons/{id}/decide": (c, [id], body) => c.decideComparison(id!, body),
  "GET /memories": (c, _ids, _body, q) =>
    c.listMemories({
      ...(q.has("kind") ? { kind: q.get("kind") as never } : {}),
      ...(q.has("status") ? { status: q.get("status") as never } : {}),
      ...(q.has("limit") ? { limit: num(q, "limit")! } : {}),
      ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}),
    }),
  "POST /memories": (c, _ids, body) => c.createMemory(body),
  "PATCH /memories/{id}": (c, [id], body) => c.updateMemory(id!, body),
  "POST /memories/{id}/supersede": (c, [id], body) => c.supersedeMemory(id!, body),
  "POST /memories/search": (c, _ids, body) => c.searchMemories(body),
  // B13.
  "GET /lines/{id}/memos": (c, [id], _body, q) => c.listMemos(id!, q.has("lineId") ? { lineId: q.get("lineId")! } : {}),
  "POST /lines/{id}/memos": (c, [id], body) => c.createMemo(id!, body),
  "PATCH /memos/{id}": (c, [id], body) => c.updateMemo(id!, (body as { text: string }).text),
  "DELETE /memos/{id}": (c, [id]) => c.deleteMemo(id!),
  // B14.
  "GET /lines/{id}/export": (c, [id]) => c.exportTree(id!),
  "POST /lines/{id}/diverge/models": (c, [id], body) => c.divergeModels(id!, body),
  // B15.
  "GET /lines/{id}/tag-drafts": (c, [id]) => c.listTagDrafts(id!),
  "POST /lines/{id}/seeds/batch": (c, [id], body) => c.createSeedsBatch(id!, body),
  // B17.
  "POST /lines/{id}/suggestions/dismiss-all": (c, [id]) => c.dismissAllSuggestions(id!),
  "PATCH /lines/{id}/branch/card": (c, [id], body) => c.updateBranchCard(id!, body),
  // B18.
  "POST /lines/import": (c, _ids, body) => c.importConversation(body),
  "POST /lines/folders/rename": (c, _ids, body) => c.renameFolder(body),
  "POST /lines/{id}/branches/extract": (c, [id], body) => c.extractBranch(id!, body),
  "GET /lines/{id}/decompose": (c, [id]) => c.decomposeLine(id!),
  // B18.1.
  "GET /lines/organization": (c) => c.getLineOrganization(),
  // B20.
  "POST /lines/{id}/attach": (c, [id], body) => c.attachLine(id!, body),
  // B22.
  "POST /lines/import-analyze": (c, _ids, body) => c.analyzeImport(body),
  // B23.
  "PUT /lines/{id}/branch/keep": (c, [id], body) => c.keepBranch(id!, (body as { keep: boolean }).keep),
  "POST /lines/{id}/branch/continue": (c, [id], body) => c.continueAside(id!, body),
  "DELETE /lines/{id}/branch": (c, [id]) => c.deleteBranch(id!),
  // B24.
  "GET /lines/{id}/terms": (c, [id]) => c.listTerms(id!),
  "POST /lines/{id}/terms": (c, [id], body) => c.createTerm(id!, body),
  "PATCH /terms/{id}": (c, [id], body) => c.updateTerm(id!, body),
  "DELETE /terms/{id}": (c, [id]) => c.deleteTerm(id!),
  "GET /terms": (c, _ids, _body, q) =>
    c.searchTerms({ ...(q.has("q") ? { q: q.get("q")! } : {}), ...(q.has("limit") ? { limit: num(q, "limit")! } : {}), ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}) }),
  // B25.
  "GET /imports": (c, _ids, _body, q) =>
    c.listImportBatches({
      ...(q.has("limit") ? { limit: num(q, "limit")! } : {}),
      ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}),
    }),
  "DELETE /imports/{id}": (c, [id], _body, q) => c.deleteImportBatch(id!, q.has("force") ? { force: flag(q, "force")! } : {}),
};

/**
 * Every sample name the contract had when F1 was reviewed; a missing one fails
 * (a renamed or dropped sample must be looked at, not silently skipped).
 */
const EXPECTED_SAMPLES = [
  ...["created", "discarded", "draft", "merged", "moved", "promoted"].map((change) => `event.branch.changed.${change}`),
  ...["chapters.changed", "line.created", "line.deleted", "line.updated", "message.created", "message.delta", "message.updated", "notes.changed", "turn.retrying"].map(
    (type) => `event.${type}`,
  ),
  ...[
    "branch.discard",
    "branch.draft",
    "branches.create",
    "branches.list",
    "branches.move",
    "branch.get",
    "branch.merge",
    "branch.promote",
    "cancel",
    "capabilities",
    "chapters.list",
    "chapters.milestones.add",
    "chapters.milestones.delete",
    "compact",
    "error.invalid_card",
    "error.line_not_found",
    // B4.1 / B4.2: the reference server's own refusals (renamed from route.server.*).
    "error.rate_limited",
    "error.unauthorized",
    "lines.archive",
    "lines.create",
    "lines.delete",
    "lines.get",
    "lines.list",
    "lines.read",
    "lines.unarchive",
    "lines.update",
    "messages.list",
    "messages.send",
    "notes.create",
    "notes.list",
    "notes.supersede",
    "notes.update",
    "preview",
    "stream",
    // B8 phase A.
    "branch.discard.leaf",
    "error.invalid_leaf",
    "error.seed_not_open",
    "error.suggestion_not_open",
    "leaf.delete",
    "leaf.draft",
    "leaf.get",
    "leaf.get.none",
    "leaf.put",
    "lines.get.inbox",
    "seeds.create",
    "seeds.drop",
    "seeds.expand",
    "seeds.list",
    "seeds.list.all",
    "seeds.to_note",
    "suggestions.accept",
    "suggestions.dismiss",
    "suggestions.list",
    "suggestions.list.all",
  ].map((name) => `route.${name}`),
  ...["leaf.changed", "seeds.changed", "suggestion.changed"].map((type) => `event.${type}`),
  // B8 phase B.
  ...["links.list", "spinoff.detach", "spinoff.fresh", "suggestions.accept.spinoff", "suggestions.list.rebalance"].map((name) => `route.${name}`),
  "event.branch.changed.detached",
  // B8.2.
  "route.spinoff.preview",
  "event.summary.due",
  "event.link.changed",
  // B9 phase A.
  ...[
    "error.goal_not_found",
    "error.relation_exists",
    "error.relation_not_found",
    "goal.delete",
    "goal.get",
    "goal.get.none",
    "goal.propose",
    "goal.put",
    "links.list.relations",
    "messages.pin",
    "messages.unpin",
    "open_loops.list",
    "open_loops.root",
    "relations.create",
    "relations.delete",
    "relations.list",
    "suggestions.accept.drift",
    "suggestions.accept.goal",
    "suggestions.accept.relation",
    "suggestions.list.p2",
  ].map((name) => `route.${name}`),
  "event.goal.changed",
  "event.link.changed.deleted",
  // B9 phase B.
  "route.preview.fisheye",
  // B9 phase C.
  ...[
    "branches.combine",
    "error.group_not_active",
    "error.invalid_group",
    "groups.create",
    "groups.dissolve",
    "groups.get",
    "groups.list",
    "groups.rename",
    "groups.summarize",
    "preview.group",
    "relations.update",
    "suggestions.accept.combine",
    "suggestions.accept.group",
    "suggestions.list.group",
  ].map((name) => `route.${name}`),
  "event.group.changed",
  "event.job.failed",
  // B10 phase A.
  ...[
    "branches.list.anchor_tag",
    "error.fold_not_found",
    "error.fold_overlap",
    "error.invalid_fold",
    "folds.create",
    "folds.delete",
    "folds.list",
    "messages.list.tagged",
    "messages.tag",
    "messages.untag",
    "preview.folds",
    "suggestions.accept.fold",
    "suggestions.list.fold",
  ].map((name) => `route.${name}`),
  "event.fold.changed",
  // B10 phase B.
  ...[
    "branches.list.diverged",
    "comparisons.decide",
    "comparisons.get",
    "comparisons.list",
    "converge",
    "diverge",
    "error.comparison_decided",
    "error.comparison_not_found",
    "error.comparison_not_ready",
    "error.invalid_comparison",
    "folds.update",
  ].map((name) => `route.${name}`),
  "event.comparison.changed",
  // B10 phase C.
  ...[
    "error.invalid_memory",
    "error.memory_not_found",
    "error.memory_superseded",
    "memories.create",
    "memories.list",
    "memories.list.page",
    "memories.list.superseded",
    "memories.search",
    "memories.supersede",
    "memories.update",
    "preview.memories",
    "suggestions.accept.memory",
    "suggestions.accept.memory_consolidate",
    "suggestions.list.memory",
  ].map((name) => `route.${name}`),
  "event.memory.changed",
  // B13.
  ...["error.memo_not_found", "memos.create", "memos.delete", "memos.list", "memos.list.node", "memos.update"].map((name) => `route.${name}`),
  "event.memo.changed",
  // B14.
  ...["diverge.models", "lines.export", "search.root", "seeds.batch"].map((name) => `route.${name}`),
  // B15.
  ...["ibis.drafts", "messages.tag.draft", "relations.kind"].map((name) => `route.${name}`),
  // B17.
  ...["suggestions.dismiss.all", "branch.card.update"].map((name) => `route.${name}`),
  // B18.
  ...["lines.import", "lines.folders.rename", "branches.extract", "lines.decompose"].map((name) => `route.${name}`),
  // B18.1.
  "route.lines.organization",
  // B20.
  "route.lines.attach",
  // B22.
  "route.lines.import_analyze",
  // B23.
  ...["branch.keep", "branch.continue", "branch.delete"].map((name) => `route.${name}`),
  "event.branch.changed.kept",
  // B24.
  ...["terms.create", "terms.list", "terms.update", "terms.search"].map((name) => `route.${name}`),
  "event.terms.changed",
  // B25.
  ...["imports.list", "imports.delete", "lines.import.batch", "lines.list.pinned"].map((name) => `route.${name}`),
];

const AUTH = "Bearer contract-token";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const used = new Set<string>();

/** "METHOD /lines/{id}/..." of a sample: ids replaced, the `/api` prefix and the query dropped. */
function routeKey(sample: RouteSample): string {
  return `${sample.method} ${sample.path.split("?")[0]!.replace(/^\/api/, "").replace(UUID, "{id}")}`;
}

/** Every key path of a JSON value ("a.b[].c"), to compare key sets explicitly. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [`${prefix}.${key}`, ...keyPaths(item, `${prefix}.${key}`)]);
}
const keySet = (value: unknown) => [...new Set(keyPaths(value))].sort();

interface Sent {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

/** A client whose fetch answers with the sample and records what was sent. */
function clientFor(sample: RouteSample): { client: TangentClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://test");
    sent.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    });
    const body = sample.response === undefined ? null : JSON.stringify(sample.response);
    return new Response(body, { status: sample.status, headers: { "Content-Type": "application/json" } });
  };
  return { client: createTangentClient({ baseUrl: "/api", fetch, headers: () => ({ Authorization: AUTH }) }), sent };
}

async function outcomeOf(name: string) {
  const sample = routeSample(name);
  const call = ROUTES[routeKey(sample)];
  if (!call) throw new Error(`no client call for ${routeKey(sample)} (${name})`);
  const { client, sent } = clientFor(sample);
  const query = new URLSearchParams(sample.path.split("?")[1] ?? "");
  const outcome = await call(client, pathIds(sample.path), sample.request as never, query).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { sample, sent, outcome };
}

describe("route samples", () => {
  it("still has every sample the client was reviewed against", () => {
    const present = new Set(sampleNames());
    expect(EXPECTED_SAMPLES.filter((name) => !present.has(name))).toStrictEqual([]);
  });

  for (const name of routeSampleNames()) {
    it(`${name}: request, headers and response match the sample`, async () => {
      used.add(name);
      const { sample, sent, outcome } = await outcomeOf(name);
      expect(sent.map(({ method, path, body }) => ({ method, path, body }))).toStrictEqual([{ method: sample.method, path: sample.path, body: sample.request }]);
      const headers = sent[0]!.headers;
      expect(headers.get("Authorization")).toBe(AUTH);
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("Content-Type")).toBe(sample.request === undefined ? null : "application/json");
      if (sample.status >= 400) {
        expect(outcome.ok).toBe(false);
        const error = (outcome as { error: unknown }).error as TangentError;
        const { error: message, code, ...extra } = sample.response as Record<string, unknown>;
        expect(error).toBeInstanceOf(TangentError);
        // Retry-After is a header, so a 429's extra may only add retryAfterSeconds.
        const { retryAfterSeconds: _retry, ...errorExtra } = error.extra;
        expect({ status: error.status, message: error.message, code: error.code, extra: errorExtra }).toStrictEqual({ status: sample.status, message, code, extra });
        expect(ALL_ERROR_CODES).toContain(code);
        return;
      }
      expect(outcome.ok).toBe(true);
      const value = (outcome as { value: unknown }).value;
      expect(keySet(value)).toStrictEqual(keySet(sample.response));
      expect(value).toStrictEqual(sample.response);
    });
  }
});

describe("event samples", () => {
  for (const name of eventSampleNames()) {
    it(`${name}: parses to the same envelope`, () => {
      used.add(name);
      const sample = eventSample(name);
      const { name: _name, ...envelope } = sample;
      const parsed = parseEvent(sample.type, JSON.stringify(envelope));
      expect(keySet(parsed)).toStrictEqual(keySet(envelope));
      expect(parsed).toStrictEqual(envelope);
    });
  }
});

describe("B17.1 card edit time", () => {
  it("the card update sample carries the edit time on the card and its branch, and the client keeps both", async () => {
    const response = routeSample("route.branch.card.update").response as { branch: { cardEditedAt?: unknown }; message: { meta: { editedAt?: unknown; delivered?: unknown } } };
    expect(typeof response.message.meta.editedAt).toBe("string");
    expect(response.branch.cardEditedAt).toBe(response.message.meta.editedAt);
    expect(response.message.meta.delivered).toBeUndefined();
    const { outcome } = await outcomeOf("route.branch.card.update");
    const value = (outcome as { value: { branch: { cardEditedAt?: string }; message: { meta: { editedAt?: string } } } }).value;
    expect(value.branch.cardEditedAt).toBe(response.message.meta.editedAt);
    expect(value.message.meta.editedAt).toBe(response.message.meta.editedAt);
  });
});

/** Every message object anywhere in a body (has role, status and seq). */
function messagesIn(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(messagesIn);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const self = typeof record.status === "string" && typeof record.role === "string" && "seq" in record ? [record] : [];
  return [...self, ...Object.values(record).flatMap(messagesIn)];
}

/**
 * B4.1 adds samples with non-zero values, `stream.lagged`, a truncated
 * stream, pending and failed replies and 401 / 403 / 409 / 415 / 422 / 429 errors. They
 * are required as soon as the capabilities sample reports `permissions`
 * (also B4.1), whatever the files are named.
 */
describe("B4.1 samples", () => {
  const landed = "permissions" in (routeSample("route.capabilities").response as Record<string, unknown>);
  const routes = () => routeSampleNames().map(routeSample);

  it.skipIf(!landed)("cover lagged events, truncated streams, pending and failed replies, non-zero usage and the new error statuses", () => {
    expect(eventSampleNames().map(eventSample).some((sample) => sample.type === "stream.lagged")).toBe(true);
    expect(routes().some((sample) => (sample.response as { truncated?: unknown } | undefined)?.truncated === true)).toBe(true);
    const statuses = new Set(routes().flatMap((sample) => messagesIn(sample.response)).map((message) => message.status));
    expect([...statuses]).toEqual(expect.arrayContaining(["pending", "error"]));
    const errors = new Set(routes().filter((sample) => sample.status >= 400).map((sample) => sample.status));
    expect([...errors]).toEqual(expect.arrayContaining([401, 403, 409, 415, 422, 429]));
    expect(routes().some((sample) => /"(inputTokens|outputTokens)":[1-9]/.test(JSON.stringify(sample.response ?? null)))).toBe(true);
  });
});

describe("coverage", () => {
  afterAll(() => {
    // Runs after every test of this file (vitest runs them in order).
    expect(sampleNames().filter((name) => !used.has(name))).toStrictEqual([]);
  });

  it("reads at least every expected sample", () => {
    expect(sampleNames().length).toBeGreaterThanOrEqual(EXPECTED_SAMPLES.length);
  });
});
