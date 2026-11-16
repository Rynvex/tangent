/**
 * The mock's `POST /lines/import` (B18, B19 in docs/devlog/B19-import-timestamps-and-assembly.md):
 * a whole conversation written at once without a model. B19 keeps the
 * source's dates (checked, in UTC, never going down in seq order), writes
 * milestone chapter cuts and branches that arrive already brought back
 * (`merged` + card: the card goes on the main line right after its anchor,
 * delivered, dated as the anchor; the leaf is written while the leaf feature
 * is on). Refusals use the server's codes, fields and order (domain.PlanImport).
 */
import {
  BRANCH_PURPOSE_MAX_RUNES,
  IMPORT_CUT_TITLE_MAX_RUNES,
  IMPORT_EARLIEST,
  IMPORT_FUTURE_SLACK_MS,
  IMPORT_MAX_BRANCH_MESSAGES,
  IMPORT_MAX_BRANCHES,
  IMPORT_MAX_CHAPTER_CUTS,
  IMPORT_MAX_MESSAGE_RUNES,
  IMPORT_MAX_MESSAGES,
  IMPORT_SOURCE_MAX_RUNES,
  type ImportBranchInput,
  type ImportChapterCutInput,
  type ImportConversationInput,
  type ImportConversationResult,
  type ImportRole,
} from "../b18-routes";
import { BRANCH_OPEN_PER_PARENT_LIMIT } from "../branch-errors";
import { IMPORT_BATCH_LABEL_MAX_RUNES } from "../b25-routes";
import { normalizeBranchCard } from "../branch-normalize";
import { isFeatureOn } from "../capabilities";
import { TangentError } from "../errors";
import type { BranchCard, BranchView, LineView, Message, Milestone } from "../types";
import type { MockContext } from "./mock-context";
import { findBranch, newId, recount, takeSeq, withBranch, withLine, withMessage, type MockState } from "./mock-store";
import { fixture } from "./scenario";

export interface MockImportDeps {
  /** The folder and tags of the body, checked as the server does. */
  organization(input: { folder?: string; tags?: string[] }): { folder?: string; tags?: string[] };
  /** The leaf a merged branch gets (the leaf feature; publishes `leaf.changed`). */
  afterMerge(lineId: string, card: BranchCard): void;
}

const runes = (text: string) => Array.from(text).length;
const IMPORT_TITLE_RUNES = 60;
/** RFC 3339 as Go's time.Time decodes it. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function invalid(field: string, message: string): TangentError {
  return new TangentError(400, `${field}: ${message}`, "invalid_input", { field });
}

/** The Markdown a conclusion card renders to (domain.RenderBranchCardMarkdown, shortened). */
export function cardMarkdown(card: BranchCard, purpose: string): string {
  return `### Branch conclusion card\n\nBranch purpose: ${purpose}\n\n**Question**\n> ${card.question}\n\n**Conclusion**\n> ${card.conclusion}\n`;
}

/** `domain.ImportTitle`: the first user message (else the first), on one line, cut to 60 characters. */
export function importTitle(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const first = messages.find((message) => message.role === "user") ?? messages[0];
  const flat = (first?.content ?? "").replace(/\s+/g, " ").trim();
  return runes(flat) <= IMPORT_TITLE_RUNES ? flat : `${Array.from(flat).slice(0, IMPORT_TITLE_RUNES - 1).join("")}…`;
}

/** `domain.checkImportTime`: an optional date, in UTC (ms); out of 1970-01-01 … now + 24h is refused. */
export function checkImportTime(field: string, raw: unknown, now: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !RFC3339.test(raw)) throw invalid(field, "the date is not an RFC 3339 time");
  const at = Date.parse(raw);
  if (Number.isNaN(at) || at < Date.parse(IMPORT_EARLIEST) || at > Date.parse(now) + IMPORT_FUTURE_SLACK_MS) {
    throw invalid(field, "the date is between 1970-01-01 and one day from now");
  }
  return at;
}

interface CheckedMessage {
  externalId: string;
  role: ImportRole;
  content: string;
  at: number | null;
}

/** The checked messages of one list (role, content cleaned, the length limit, the date). */
function checkMessages(field: string, messages: ReadonlyArray<{ externalId?: string; role?: string; content?: string; createdAt?: string }>, now: string): CheckedMessage[] {
  return messages.map((message, index) => {
    const at = `${field}[${index}]`;
    const role = (message.role ?? "").trim();
    if (role !== "user" && role !== "assistant") throw invalid(`${at}.role`, "role is user or assistant");
    const content = (message.content ?? "").replace(/\r\n?/g, "\n").trim();
    if (content === "") throw invalid(`${at}.content`, "content is empty");
    if (runes(content) > IMPORT_MAX_MESSAGE_RUNES) throw new TangentError(422, "a text is too long", "too_long", { field: `${at}.content`, limit: IMPORT_MAX_MESSAGE_RUNES });
    return { externalId: (message.externalId ?? "").trim(), role, content, at: checkImportTime(`${at}.createdAt`, message.createdAt, now) };
  });
}

/** `domain.planImportCard`: a merged branch carries a card (no message cited), any other none; an empty question is the purpose. */
function checkCard(field: string, raw: unknown, status: string, purpose: string): BranchCard | null {
  if (status !== "merged") {
    if (raw !== undefined && raw !== null) throw invalid(`${field}.card`, "only a merged branch carries a card");
    return null;
  }
  if (raw === undefined || raw === null) throw invalid(`${field}.card`, "a merged branch carries its card");
  const card = normalizeBranchCard(raw);
  if (!card) throw new TangentError(422, "the card is not acceptable", "invalid_card", { problems: [{ field: `${field}.card`, message: "must be an object" }] });
  const filled = { ...card, question: card.question.trim() || purpose };
  const problems = [
    ...(filled.conclusion.trim() ? [] : [{ field: `${field}.card.conclusion`, message: "required" }]),
    ...filled.evidence.map((_, i) => ({ field: `${field}.card.evidence[${i}].messageId`, message: "an imported card cites no message" })),
    ...filled.excerpts.map((_, i) => ({ field: `${field}.card.excerpts[${i}]`, message: "an imported card cites no message" })),
  ];
  if (problems.length > 0) throw new TangentError(422, "the card is not acceptable", "invalid_card", { problems });
  return filled;
}

interface CheckedBranch {
  anchor: number;
  kind: "investigate" | "alternative";
  status: "open" | "discarded" | "merged";
  purpose: string;
  card: BranchCard | null;
  at: number | null;
  messages: CheckedMessage[];
}

function checkBranch(index: number, branch: ImportBranchInput, anchors: ReadonlyMap<string, number>, now: string): CheckedBranch {
  const field = `branches[${index}]`;
  const anchor = anchors.get((branch.anchorExternalId ?? "").trim());
  if (anchor === undefined) throw invalid(`${field}.anchorExternalId`, "anchorExternalId names no message of the import");
  const kind = branch.kind ?? "alternative";
  if (kind !== "investigate" && kind !== "alternative") throw invalid(`${field}.kind`, "kind is investigate or alternative");
  const status = branch.status ?? "discarded";
  if (status !== "open" && status !== "discarded" && status !== "merged") throw invalid(`${field}.status`, "status is open, discarded or merged");
  const at = checkImportTime(`${field}.createdAt`, branch.createdAt, now);
  const list = branch.messages ?? [];
  if (list.length === 0 || list.length > IMPORT_MAX_BRANCH_MESSAGES) throw invalid(`${field}.messages`, `a branch has 1 to ${IMPORT_MAX_BRANCH_MESSAGES} messages`);
  const messages = checkMessages(`${field}.messages`, list, now);
  const purpose = (branch.purpose ?? "").trim() || importTitle(messages);
  if (!purpose || runes(purpose) > BRANCH_PURPOSE_MAX_RUNES) throw invalid(`${field}.purpose`, "purpose is required and must not be too long");
  return { anchor, kind, status, purpose, card: checkCard(field, branch.card, status, purpose), at, messages };
}

/** `domain.planImportCuts`: each names a main-line message (one cut per message), a title of 1–60 characters on one line. */
function checkCuts(cuts: readonly ImportChapterCutInput[], anchors: ReadonlyMap<string, number>, limits: { maxMilestones: number; milestoneMaxLen: number }): Array<{ anchor: number; title: string }> {
  const limit = Math.min(IMPORT_MAX_CHAPTER_CUTS, limits.maxMilestones);
  if (cuts.length > limit) throw invalid("chapterCuts", `an import has at most ${limit} chapter cuts`);
  const titleMax = Math.min(IMPORT_CUT_TITLE_MAX_RUNES, limits.milestoneMaxLen);
  const seen = new Set<number>();
  return cuts.map((cut, index) => {
    const field = `chapterCuts[${index}]`;
    const anchor = anchors.get((cut.anchorExternalId ?? "").trim());
    if (anchor === undefined) throw invalid(`${field}.anchorExternalId`, "anchorExternalId names no main-line message of the import");
    if (seen.has(anchor)) throw invalid(`${field}.anchorExternalId`, "this message already has a chapter cut");
    const title = (cut.title ?? "").replace(/\s+/g, " ").trim();
    if (runes(title) === 0 || runes(title) > titleMax) throw invalid(`${field}.title`, `title is 1 to ${titleMax} characters`);
    seen.add(anchor);
    return { anchor, title };
  });
}

/**
 * `domain.dateImportLine`: the line starts at the earlier of its createdAt and its first dated message (now without either);
 * a message without a date, or dated before the one above it, takes that one's date.
 */
export function dateImportLine(dates: ReadonlyArray<number | null>, lineAt: number | null, now: number): { dates: number[]; start: number; last: number } {
  let start = lineAt ?? now;
  const firstDated = dates.find((at): at is number => at !== null);
  if (firstDated !== undefined && (lineAt === null || firstDated < start)) start = firstDated;
  const out: number[] = [];
  let previous = start;
  for (const at of dates) {
    previous = at !== null && at > previous ? at : previous;
    out.push(previous);
  }
  return { dates: out, start, last: previous };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function planImportBatch(id?: string, label?: string): { id: string; label: string } | null {
  const batchId = (id ?? "").trim();
  const batchLabel = (label ?? "").replace(/\s+/g, " ").trim();
  if (batchId === "") {
    if (batchLabel !== "") throw invalid("batchLabel", "batchLabel needs a batchId");
    return null;
  }
  if (!UUID_RE.test(batchId) || batchId.toLowerCase() === NIL_UUID) throw invalid("batchId", "batchId is a UUID chosen by the client");
  if (runes(batchLabel) > IMPORT_BATCH_LABEL_MAX_RUNES) {
    throw new TangentError(400, "batchLabel: the label is too long", "invalid_input", { field: "batchLabel", max: IMPORT_BATCH_LABEL_MAX_RUNES });
  }
  return { id: batchId.toLowerCase(), label: batchLabel };
}

interface Checked {
  source: string;
  batch: { id: string; label: string } | null;
  lineAt: number | null;
  messages: CheckedMessage[];
  branches: CheckedBranch[];
  cuts: Array<{ anchor: number; title: string }>;
}

/** `domain.PlanImport`'s checks, in its order. */
function checkImport(input: ImportConversationInput, now: string, limits: { maxMilestones: number; milestoneMaxLen: number }): Checked {
  const batch = planImportBatch(input.batchId, input.batchLabel);
  const source = (input.source ?? "").replace(/\s+/g, " ").trim();
  if (runes(source) > IMPORT_SOURCE_MAX_RUNES) throw invalid("source", `source is at most ${IMPORT_SOURCE_MAX_RUNES} characters`);
  const given = input.messages ?? [];
  if (given.length === 0 || given.length > IMPORT_MAX_MESSAGES) throw invalid("messages", `an import has 1 to ${IMPORT_MAX_MESSAGES} messages`);
  const branchesIn = input.branches ?? [];
  if (branchesIn.length > IMPORT_MAX_BRANCHES) throw invalid("branches", `an import has at most ${IMPORT_MAX_BRANCHES} branches`);
  const lineAt = checkImportTime("createdAt", input.createdAt, now);
  const messages = checkMessages("messages", given, now);
  const anchors = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!message.externalId) return;
    if (anchors.has(message.externalId)) throw invalid(`messages[${index}].externalId`, "externalId is used twice");
    anchors.set(message.externalId, index);
  });
  const branches = branchesIn.map((branch, index) => checkBranch(index, branch, anchors, now));
  const cuts = checkCuts(input.chapterCuts ?? [], anchors, limits);
  if (branches.filter((branch) => branch.status === "open").length > BRANCH_OPEN_PER_PARENT_LIMIT) {
    throw new TangentError(409, "too many open branches", "branch_limit", { limit: BRANCH_OPEN_PER_PARENT_LIMIT });
  }
  return { source, batch, lineAt, messages, branches, cuts };
}

/** Whether anything in the import carries a date (`domain.importHasDates`); without one every line is dated now, as before B19. */
const hasDates = (checked: Checked) => checked.lineAt !== null || checked.messages.some((m) => m.at !== null) || checked.branches.some((b) => b.at !== null || b.messages.some((m) => m.at !== null));

export interface MockImport {
  importConversation(input: ImportConversationInput): ImportConversationResult;
}

type NewMessage = Omit<Parameters<typeof fixture.message>[0], "id" | "seq" | "lineId">;

/** Writes onto a working copy of the state (ids and seqs taken in order), committed once at the end. */
function createWriter(initial: MockState) {
  let state = initial;
  const take = (prefix: string) => {
    const [id, next] = newId(state, prefix);
    state = next;
    return id;
  };
  return {
    take,
    state: () => state,
    update: (change: (current: MockState) => MockState) => {
      state = change(state);
    },
    write(lineId: string, message: NewMessage, prefix = "msg"): Message {
      const [seq, seqState] = takeSeq(state);
      state = seqState;
      const written = fixture.message({ ...message, id: take(prefix), seq, lineId });
      state = withMessage(state, written);
      return written;
    },
  };
}

type Writer = ReturnType<typeof createWriter>;
const iso = (ms: number) => new Date(ms).toISOString();

/** The main line's messages; each merged branch anchored on one leaves its card right after it (input order, the anchor's date). */
function writeMain(writer: Writer, rootId: string, checked: Checked, dates: readonly number[], branchIds: readonly string[]): { messages: Message[]; cardIds: Map<number, string> } {
  const messages: Message[] = [];
  const cardIds = new Map<number, string>();
  checked.messages.forEach((message, index) => {
    const at = iso(dates[index]!);
    messages.push(writer.write(rootId, { role: message.role, kind: "chat", status: "done", content: message.content, createdAt: at }));
    checked.branches.forEach((branch, b) => {
      if (branch.anchor !== index || !branch.card) return;
      const meta = { branchLineId: branchIds[b]!, card: branch.card, delivered: true };
      cardIds.set(b, writer.write(rootId, { role: "system", kind: "branch_card", status: "done", content: cardMarkdown(branch.card, branch.purpose), createdAt: at, meta }, "card").id);
    });
  });
  return { messages, cardIds };
}

interface Created {
  line: LineView;
  branch: BranchView;
  card: BranchCard | null;
}

type LineDates = (messages: readonly CheckedMessage[], lineAt: number | null) => { dates: number[]; start: number; last: number };

/** One imported branch: its line, its view (ended ones closed at their last message; merged ones name their card) and messages. */
function writeBranch(writer: Writer, main: LineView, branch: CheckedBranch, id: string, anchorId: string, cardId: string | undefined, lineDates: LineDates): Created {
  const dates = lineDates(branch.messages, branch.at);
  const ref = { parentLineId: main.id, rootLineId: main.id, anchorMessageId: anchorId, depth: 1, purpose: branch.purpose, kind: branch.kind, status: branch.status, origin: "import" };
  const line = fixture.line({ id, title: branch.purpose, provider: main.provider, model: main.model, conversationBranch: ref, createdAt: iso(dates.start), updatedAt: iso(dates.last), lastActivityAt: iso(dates.last) });
  const view: BranchView = fixture.branch({
    ...ref,
    lineId: id,
    provider: main.provider,
    model: main.model,
    draftStatus: "none",
    messageCount: branch.messages.length,
    createdAt: iso(dates.start),
    lastActivityAt: iso(dates.last),
    closedAt: branch.status !== "open" ? iso(dates.last) : null,
    ...(branch.card && cardId ? { cardMessageId: cardId, conclusionLine: branch.card.conclusion } : {}),
  });
  writer.update((state) => withBranch(withLine(state, line), view));
  branch.messages.forEach((message, index) => writer.write(id, { role: message.role, kind: "chat", status: "done", content: message.content, createdAt: iso(dates.dates[index]!) }));
  return { line, branch: view, card: branch.card };
}

export function createMockImport(ctx: MockContext, deps: MockImportDeps): MockImport {
  function importConversation(input: ImportConversationInput): ImportConversationResult {
    const now = ctx.now();
    const checked = checkImport(input, now, ctx.scenario.chapterLimits);
    const org = deps.organization({ ...(input.folder !== undefined ? { folder: input.folder } : {}), ...(input.tags !== undefined ? { tags: input.tags } : {}) });
    const nowMs = Date.parse(now);
    const dated = hasDates(checked);
    const lineDates: LineDates = (messages, lineAt) =>
      dated ? dateImportLine(messages.map((message) => message.at), lineAt, nowMs) : { dates: messages.map(() => nowMs), start: nowMs, last: nowMs };
    const mainDates = lineDates(checked.messages, checked.lineAt);
    const writer = createWriter(ctx.state());
    const rootId = writer.take("line");
    const main = fixture.line({
      id: rootId,
      title: (input.title ?? "").trim() || importTitle(checked.messages),
      provider: input.provider ?? "",
      model: input.model ?? "",
      folder: org.folder ?? "",
      tags: org.tags ?? [],
      ...(checked.batch ? { importBatchId: checked.batch.id } : {}),
      createdAt: iso(mainDates.start),
      updatedAt: iso(mainDates.last),
      lastActivityAt: iso(mainDates.last),
    });
    writer.update((state) => withLine(state, main));
    // Branch line ids first, so a merged branch's card names its line when it is written after the anchor.
    const branchIds = checked.branches.map(() => writer.take("branch"));
    const { messages, cardIds } = writeMain(writer, rootId, checked, mainDates.dates, branchIds);
    const created = checked.branches.map((branch, b) => writeBranch(writer, main, branch, branchIds[b]!, messages[branch.anchor]!.id, cardIds.get(b), lineDates));
    // The milestones are written whether or not the chapters feature is on (store.importCuts).
    const milestones: Milestone[] = checked.cuts.map((cut) => ({ id: writer.take("milestone"), messageId: messages[cut.anchor]!.id, kind: "milestone", title: cut.title, createdBy: "mock-user", createdAt: now }));
    if (milestones.length > 0) writer.update((state) => ({ ...state, chaptersByLine: { ...state.chaptersByLine, [rootId]: { chapters: [], milestones } } }));
    if (checked.batch) {
      const batch = checked.batch;
      writer.update((state) => ({
        ...state,
        importBatches: state.importBatches.some((item) => item.id === batch.id)
          ? state.importBatches
          : [...state.importBatches, { id: batch.id, label: batch.label, createdAt: now }],
        importBaselines: { ...state.importBaselines, [rootId]: { activityAt: main.lastActivityAt, seq: state.seq } },
      }));
    }
    ctx.commit(writer.state());
    publishImport(rootId, created, milestones.length > 0);
    return { line: recount(ctx.state(), rootId), branches: created.map((item) => findBranch(ctx.state(), item.line.id)), messageCount: messages.length };
  }

  /** Engine.importEvents: the main line, each branch (line and created), each merged branch's leaf, then the chapters. */
  function publishImport(rootId: string, created: readonly Created[], cuts: boolean): void {
    ctx.bus.publish("line.created", { lineId: rootId, rootLineId: rootId }, recount(ctx.state(), rootId));
    for (const item of created) {
      ctx.bus.publish("line.created", { lineId: item.line.id, rootLineId: rootId }, item.line);
      ctx.bus.publish("branch.changed", { lineId: item.line.id, rootLineId: rootId }, { change: "created", branch: item.branch });
    }
    for (const item of created) if (item.card) deps.afterMerge(item.line.id, item.card);
    if (cuts && isFeatureOn(ctx.scenario.capabilities, "chapters")) ctx.bus.publish("chapters.changed", { lineId: rootId, rootLineId: rootId }, { rootLineId: rootId });
  }

  return { importConversation };
}
