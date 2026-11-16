/**
 * F14 S3–S4: the blueprint of an assembly (import-assembly.ts has the
 * rules): the preview's nodes, the import bodies in the order they are
 * sent, what keeps them from being sent, and the summary bar's numbers.
 */
import type { ImportBranchInput, ImportChapterCutInput, ImportConversationInput, ImportMessageInput } from "./b18-routes";
import {
  IMPORT_EARLIEST,
  IMPORT_FUTURE_SLACK_MS,
  IMPORT_CUT_TITLE_MAX_RUNES,
  IMPORT_MAX_BODY_BYTES,
  IMPORT_MAX_BRANCH_MESSAGES,
  IMPORT_MAX_BRANCHES,
  IMPORT_MAX_CHAPTER_CUTS,
  IMPORT_MAX_MESSAGE_RUNES,
  IMPORT_MAX_MESSAGES,
  IMPORT_MAX_OPEN_BRANCHES,
  BRANCH_PURPOSE_MAX_RUNES,
  normalizeFolder,
  normalizeTags,
} from "./b18-routes";
import {
  cutText,
  defaultAttachMessage,
  editsOf,
  effectiveRoles,
  filledTimes,
  keptCount,
  keptOf,
  organizationProblems,
  prefillSessionCard,
  sessionProblems,
  standaloneImport,
  type AssemblyBlueprint,
  type AssemblyProblem,
  type AttachPoint,
  type BlueprintNode,
  type BuildAssemblyInput,
  type NodeRole,
} from "./import-assembly";
import { buildImportPlan, DEFAULT_BRANCH_LABELS, importBodyBytes } from "./import-plan";
import { findInterleaves, selectionSummary, sessionMessageTimes, sessionStartIso, sessionTimes, type TimelineSession } from "./import-timeline";

const SOURCE_MAX_RUNES = 40;

/** A chapter's messages and restored versions under ids unique in the assembly ("c2-m4"), and its parsed id → that id. */
interface ChapterPart {
  session: TimelineSession;
  number: number;
  messages: ImportMessageInput[];
  versions: ImportBranchInput[];
  ids: Map<string, string>;
  problems: AssemblyProblem[];
  /** Versions buildImportPlan already left out (over 20 in the session itself). */
  dropped: number;
}

function chapterPart(session: TimelineSession, number: number, input: BuildAssemblyInput): ChapterPart {
  const prefix = `c${number}-`;
  const plan = buildImportPlan(
    session.conversation,
    editsOf(input.edits, session.key),
    { title: "", folder: "", tags: [], restoreBranches: true, source: session.source, messageTimes: sessionMessageTimes(session), createdAt: null },
    input.options.labels ?? DEFAULT_BRANCH_LABELS,
  );
  // buildImportPlan names the kept messages m1…mN in order.
  const ids = new Map(keptOf(session, input.edits).map((message, index) => [message.externalId, `${prefix}m${index + 1}`]));
  return {
    session,
    number,
    messages: plan.input.messages.map((message) => ({ ...message, externalId: `${prefix}${message.externalId}` })),
    versions: (plan.input.branches ?? []).map((branch) => ({ ...branch, anchorExternalId: `${prefix}${branch.anchorExternalId}` })),
    ids,
    problems: sessionProblems(session.key, plan.problems),
    dropped: plan.droppedBranches,
  };
}

/** The kept message a point names, or the nearest kept one above it (it was removed); null when there is none. */
function keptAt(part: ChapterPart, externalId: string): string | null {
  const all = part.session.conversation.messages;
  for (let i = all.findIndex((message) => message.externalId === externalId); i >= 0; i -= 1) {
    const id = part.ids.get(all[i]!.externalId);
    if (id) return all[i]!.externalId;
  }
  return null;
}

interface Attached {
  node: NonNullable<BlueprintNode["attach"]>;
  anchorId: string | null;
}

/** A branch's attach point: the user's (checked) or decision #3's default on the latest chapter before it (else the first). */
function attachOf(session: TimelineSession, order: readonly TimelineSession[], parts: ReadonlyMap<string, ChapterPart>, input: BuildAssemblyInput): Attached | null {
  const chosen = input.edits.attach?.[session.key];
  if (chosen) {
    const part = parts.get(chosen.sessionKey);
    const externalId = part ? keptAt(part, chosen.externalId) : null;
    if (!part || !externalId) return { node: { point: chosen, chapter: null, number: 0, at: null, auto: false, valid: false }, anchorId: null };
    return { node: pointNode(part, { sessionKey: part.session.key, externalId }, false, input), anchorId: part.ids.get(externalId)! };
  }
  const index = order.indexOf(session);
  const before = order.slice(0, index).filter((item) => parts.has(item.key)).at(-1) ?? order.find((item) => parts.has(item.key));
  if (!before) return null;
  const part = parts.get(before.key)!;
  const externalId = defaultAttachMessage(part.session, sessionTimes(session).start, input.edits);
  if (!externalId) return null;
  return { node: pointNode(part, { sessionKey: part.session.key, externalId }, true, input), anchorId: part.ids.get(externalId)! };
}

function pointNode(part: ChapterPart, point: AttachPoint, auto: boolean, input: BuildAssemblyInput): NonNullable<BlueprintNode["attach"]> {
  const number = part.session.conversation.messages.findIndex((message) => message.externalId === point.externalId) + 1;
  const at = filledTimes(part.session, input.edits).find((item) => item.externalId === point.externalId)?.at ?? null;
  return { point, chapter: part.number, number, at, auto, valid: true };
}

/** A merged or open branch made from a session. */
function sessionBranch(session: TimelineSession, role: NodeRole, anchorId: string, card: { question: string; conclusion: string } | null, input: BuildAssemblyInput): ImportBranchInput {
  const times = sessionMessageTimes(session);
  const edits = editsOf(input.edits, session.key);
  const purpose = cutText(session.conversation.title || prefillSessionCard(session, input.edits).question, BRANCH_PURPOSE_MAX_RUNES);
  const start = sessionStartIso(session);
  return {
    anchorExternalId: anchorId,
    purpose,
    kind: "investigate",
    status: role === "merged_branch" ? "merged" : "open",
    ...(card ? { card: { question: card.question, conclusion: card.conclusion.trim() } } : {}),
    ...(start ? { createdAt: start } : {}),
    messages: keptOf(session, input.edits)
      .slice(0, IMPORT_MAX_BRANCH_MESSAGES)
      .map((message) => {
        const at = times.get(message.externalId);
        return { role: edits.roles[message.externalId] ?? message.role, content: message.content, ...(at ? { createdAt: at } : {}) };
      }),
  };
}

/** Problems of a branch made from a session: too long, a message over the limit, nothing kept, an empty conclusion. */
function branchProblems(session: TimelineSession, card: { conclusion: string } | null, input: BuildAssemblyInput): AssemblyProblem[] {
  const kept = keptOf(session, input.edits);
  const numbers = session.conversation.messages.flatMap((message, index) => (kept.includes(message) && Array.from(message.content).length > IMPORT_MAX_MESSAGE_RUNES ? [index + 1] : []));
  return [
    ...(kept.length === 0 ? [{ kind: "emptySession" as const, key: session.key }] : []),
    ...(kept.length > IMPORT_MAX_BRANCH_MESSAGES ? [{ kind: "branchTooLong" as const, key: session.key, messages: kept.length }] : []),
    ...(numbers.length > 0 ? [{ kind: "messageTooLong" as const, key: session.key, numbers }] : []),
    ...(card && !card.conclusion.trim() ? [{ kind: "cardEmpty" as const, key: session.key }] : []),
  ];
}

/** "chatgpt+claude+markdown" (at most 40 characters). */
function sourceLabel(sessions: readonly TimelineSession[]): string {
  return cutText([...new Set(sessions.map((session) => session.source))].join("+"), SOURCE_MAX_RUNES);
}

interface TreeResult {
  input: ImportConversationInput | null;
  nodes: BlueprintNode[];
  problems: AssemblyProblem[];
  droppedVersions: number;
  keys: string[];
}

/** The main tree of timeline / tree: chapters in order with a cut at each (two or more), branches with their cards. */
function treeImport(sessions: readonly TimelineSession[], roles: Readonly<Record<string, NodeRole>>, input: BuildAssemblyInput): TreeResult {
  const chapters = sessions.filter((session) => roles[session.key] === "chapter");
  const parts = new Map(chapters.map((session, index) => [session.key, chapterPart(session, index + 1, input)]));
  const problems: AssemblyProblem[] = chapters.length === 0 ? [{ kind: "noChapter" }] : [...parts.values()].flatMap((part) => part.problems);
  const nodes: BlueprintNode[] = [];
  const branches: ImportBranchInput[] = [];
  for (const session of sessions) {
    const role = roles[session.key]!;
    const messages = keptCount(session, input.edits);
    if (role === "chapter") {
      nodes.push({ key: session.key, role, chapter: parts.get(session.key)!.number, attach: null, card: null, messages, interleaved: false });
      continue;
    }
    const attached = attachOf(session, sessions, parts, input);
    const prefill = prefillSessionCard(session, input.edits);
    const card = role === "merged_branch" ? { question: prefill.question, conclusion: input.edits.conclusions?.[session.key] ?? prefill.conclusion } : null;
    nodes.push({ key: session.key, role, chapter: null, attach: attached?.node ?? null, card, messages, interleaved: false });
    problems.push(...branchProblems(session, card, input));
    if (attached && !attached.node.valid) problems.push({ kind: "invalidAttach", key: session.key, target: attached.node.point.sessionKey });
    if (attached?.anchorId) branches.push(sessionBranch(session, role, attached.anchorId, card, input));
  }
  const versions = [...parts.values()].flatMap((part) => part.versions);
  const kept = [...branches, ...versions.slice(0, Math.max(IMPORT_MAX_BRANCHES - branches.length, 0))];
  const mainCount = chapters.reduce((sum, session) => sum + keptCount(session, input.edits), 0);
  problems.push(...countProblems(branches, mainCount, chapters.length));
  if (chapters.length === 0) return { input: null, nodes, problems, droppedVersions: 0, keys: sessions.map((session) => session.key) };
  const cuts: ImportChapterCutInput[] = chapters.length < 2 ? [] : [...parts.values()].map((part) => ({ anchorExternalId: `c${part.number}-m1`, title: cutText(part.session.conversation.title || prefillSessionCard(part.session, input.edits).question, IMPORT_CUT_TITLE_MAX_RUNES) }));
  const folder = normalizeFolder(input.options.folder).folder;
  const tags = normalizeTags(input.options.tags).tags;
  const start = sessionStartIso(chapters[0]!);
  const body: ImportConversationInput = {
    title: input.options.title.trim() || chapters[0]!.conversation.title,
    ...(folder ? { folder } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    source: sourceLabel(sessions),
    ...(start ? { createdAt: start } : {}),
    messages: [...parts.values()].flatMap((part) => part.messages),
    ...(kept.length > 0 ? { branches: kept } : {}),
    ...(cuts.length > 0 ? { chapterCuts: cuts.filter((cut) => cut.title !== "") } : {}),
  };
  const bytes = importBodyBytes(body);
  if (bytes > IMPORT_MAX_BODY_BYTES) problems.push({ kind: "bodyTooLarge", bytes });
  return { input: body, nodes, problems, droppedVersions: versions.length - (kept.length - branches.length) + [...parts.values()].reduce((sum, part) => sum + part.dropped, 0), keys: sessions.map((session) => session.key) };
}

/** The tree's limits: 2,000 main-line messages, 50 branches, 8 open, 50 chapter cuts. */
function countProblems(branches: readonly ImportBranchInput[], mainCount: number, chapters: number): AssemblyProblem[] {
  const open = branches.filter((branch) => branch.status === "open").length;
  return [
    ...(mainCount > IMPORT_MAX_MESSAGES ? [{ kind: "over200" as const, messages: mainCount }] : []),
    ...(branches.length > IMPORT_MAX_BRANCHES ? [{ kind: "tooManyBranches" as const, count: branches.length }] : []),
    ...(open > IMPORT_MAX_OPEN_BRANCHES ? [{ kind: "tooManyOpen" as const, count: open }] : []),
    ...(chapters > IMPORT_MAX_CHAPTER_CUTS ? [{ kind: "tooManyChapters" as const, count: chapters }] : []),
  ];
}

/** Sessions with a date the server refuses (domain.checkImportTime: 1970-01-01 to now + 24h), counting a time the user set. */
function dateProblems(sessions: readonly TimelineSession[], now: number): AssemblyProblem[] {
  const earliest = Date.parse(IMPORT_EARLIEST);
  const outside = (iso: string | null | undefined) => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    return !Number.isNaN(at) && (at < earliest || at > now + IMPORT_FUTURE_SLACK_MS);
  };
  return sessions.flatMap((session) => {
    const versions = session.conversation.branches.flatMap((branch) => branch.messages.map((message) => message.createdAt));
    const dates = [...sessionMessageTimes(session).values(), sessionStartIso(session), ...versions];
    return dates.some(outside) ? [{ kind: "dateOutOfRange" as const, key: session.key }] : [];
  });
}

/** The preview, the imports in order and their problems for one mode and the user's changes. */
export function buildAssemblyBlueprint(input: BuildAssemblyInput): AssemblyBlueprint {
  const { mode, sessions, edits } = input;
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const order = sessions.map((session) => session.key);
  const interleaves = findInterleaves(order, byKey);
  const total = sessions.reduce((sum, session) => sum + keptCount(session, edits), 0);
  const roles = effectiveRoles(mode, sessions, edits);
  const inTree = sessions.filter((session) => roles[session.key] !== "standalone");
  const tree = mode === "batch" || inTree.length === 0 ? null : treeImport(inTree, roles, input);
  const standalone = sessions.filter((session) => roles[session.key] === "standalone").map((session) => ({ session, ...standaloneImport(session, input) }));
  const placed = [
    ...(tree?.input ? [{ at: order.indexOf(tree.keys[0]!), input: tree.input, keys: tree.keys }] : []),
    ...standalone.map((item) => ({ at: order.indexOf(item.session.key), input: item.input, keys: [item.session.key] })),
  ].sort((a, b) => a.at - b.at);
  const interleaved = new Set(interleaves.map((item) => item.inner));
  const treeNodes = new Map((tree?.nodes ?? []).map((node) => [node.key, node]));
  const nodes = sessions.map((session): BlueprintNode => ({
    ...(treeNodes.get(session.key) ?? { key: session.key, role: "standalone" as const, chapter: null, attach: null, card: null, messages: keptCount(session, edits) }),
    interleaved: interleaved.has(session.key),
  }));
  const problems = [...(tree?.problems ?? []), ...standalone.flatMap((item) => item.problems), ...dateProblems(sessions, input.now ?? Date.now()), ...organizationProblems(input.options)];
  const range = selectionSummary(sessions);
  const branchNodes = nodes.filter((node) => node.role === "merged_branch" || node.role === "open_branch");
  return {
    mode,
    nodes,
    imports: placed.map((item) => item.input),
    importKeys: placed.map((item) => item.keys),
    problems,
    interleaves,
    recommendTree: interleaves.length > 0 || total > IMPORT_MAX_MESSAGES,
    summary: {
      lines: placed.length,
      chapters: nodes.filter((node) => node.role === "chapter").length,
      branches: branchNodes.length,
      cards: branchNodes.filter((node) => node.role === "merged_branch").length,
      messages: total,
      from: range.from,
      to: range.to,
      relations: input.relations ? Math.max(placed.length - 1, 0) : 0,
    },
    droppedVersions: tree?.droppedVersions ?? 0,
  };
}
