/**
 * Chapters as the mock serves them. A line without stored chapters is cut
 * as domain/chapters.go cuts it (B20, F14.1): the start of the line, an idle
 * cut where a message comes more than 30 minutes after the one before it
 * (`DefaultChapterLimits.IdleGap`), and the operator's milestones; cuts closer
 * than 3 messages (`MinMessages`) fold into the higher-ranked one (the earlier
 * on a tie, a milestone always survives next to the start) and at most 60
 * chapters are kept (`MaxCount`). Like the server it reads the line's finished
 * messages in seq order, cards and markers included, titles a chapter
 * without a named milestone by its time (UTC) and lists the branches opened
 * in each chapter. A scenario's stored
 * chapters are kept as written and only split at each milestone.
 */
import type { Chapter, Message, Milestone } from "../types";

/** `DefaultChapterLimits` (domain/limits.go). */
export const MOCK_IDLE_GAP_MS = 30 * 60_000;
export const MOCK_CHAPTER_MIN_MESSAGES = 3;
export const MOCK_CHAPTER_MAX_COUNT = 60;

const isChat = (message: Message) => message.kind === "chat" && (message.role === "user" || message.role === "assistant");

type CutKind = "start" | "idle" | "milestone";

interface Boundary {
  index: number;
  kind: CutKind;
  milestone: Milestone | null;
}

const RANK: Record<CutKind, number> = { start: 0, idle: 1, milestone: 3 };

/** `collectBoundaries`: one candidate per message index, sorted; index 0 is always the start. */
function collectBoundaries(messages: readonly Message[], milestones: readonly Milestone[]): Boundary[] {
  const byIndex = new Map<number, Boundary>([[0, { index: 0, kind: "start", milestone: null }]]);
  const at = (index: number): Boundary => {
    const found = byIndex.get(index);
    if (found) return found;
    const made: Boundary = { index, kind: "start", milestone: null };
    byIndex.set(index, made);
    return made;
  };
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]!.kind !== "branch_card" && Date.parse(messages[i]!.createdAt) - Date.parse(messages[i - 1]!.createdAt) > MOCK_IDLE_GAP_MS) at(i).kind = "idle";
  }
  const position = new Map(messages.map((message, index) => [message.id, index]));
  for (const milestone of [...milestones].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const index = position.get(milestone.messageId);
    if (index === undefined) continue;
    const boundary = at(index);
    boundary.kind = "milestone";
    boundary.milestone = milestone;
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/** `foldCloseBoundaries` / `pushBoundary`. */
function foldClose(bounds: readonly Boundary[]): Boundary[] {
  const kept: Boundary[] = [];
  for (const boundary of bounds) {
    let push = true;
    while (kept.length > 0 && boundary.index - kept.at(-1)!.index < MOCK_CHAPTER_MIN_MESSAGES) {
      const top = kept.at(-1)!;
      if (top.index === 0) {
        push = boundary.kind === "milestone";
        break;
      }
      if (RANK[boundary.kind] <= RANK[top.kind]) {
        push = false;
        break;
      }
      kept.pop();
    }
    if (push) kept.push(boundary);
  }
  return kept;
}

/** `capBoundaries`: the shortest chapter merges into its neighbour until at most MaxCount are left. */
function cap(bounds: readonly Boundary[], total: number): Boundary[] {
  let out = [...bounds];
  while (out.length > MOCK_CHAPTER_MAX_COUNT) {
    let shortest = 0;
    let shortestLength = total + 1;
    out.forEach((boundary, j) => {
      const length = (out[j + 1]?.index ?? total) - boundary.index;
      if (length < shortestLength) [shortest, shortestLength] = [j, length];
    });
    const drop = shortest === 0 ? 1 : shortest;
    out = [...out.slice(0, drop), ...out.slice(drop + 1)];
  }
  return out;
}

/** A branch hanging off a message of the line (`domain.ChapterBranch`). */
export interface ChapterBranchRef {
  lineId: string;
  anchorMessageId: string;
}

/** `chapterTitle`'s time title: the chapter's first message, UTC, "2006-01-02 15:04". */
const timeTitle = (iso: string) => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(0, 16).replace("T", " ");
};

/** `ComputeChapters` over the line's finished messages (seq order); a chapter without a named milestone is titled by its time. */
export function computeChapters(messages: readonly Message[], milestones: readonly Milestone[], branches: readonly ChapterBranchRef[] = []): Chapter[] {
  const done = messages.filter((message) => message.status === "done").sort((a, b) => a.seq - b.seq);
  if (done.length === 0) return [];
  const bounds = cap(foldClose(collectBoundaries(done, milestones)), done.length);
  const position = new Map(done.map((message, index) => [message.id, index]));
  const chapterOf = (index: number) => bounds.reduce((found, boundary, j) => (boundary.index <= index ? j : found), 0);
  const hanging = branches.flatMap((branch) => {
    const index = position.get(branch.anchorMessageId);
    return index === undefined ? [] : [{ lineId: branch.lineId, chapter: chapterOf(index) }];
  });
  return bounds.map((boundary, j) => {
    const end = bounds[j + 1]?.index ?? done.length;
    const stretch = done.slice(boundary.index, end);
    const first = stretch[0]!;
    const last = stretch.at(-1)!;
    const name = boundary.milestone?.title.trim() ? boundary.milestone.title : "";
    return {
      index: j,
      title: name || timeTitle(first.createdAt),
      titleSource: name ? "milestone" : "time",
      kind: boundary.kind,
      milestoneId: boundary.milestone?.id ?? "",
      startMessageId: first.id,
      endMessageId: last.id,
      startAt: first.createdAt,
      endAt: last.createdAt,
      messageCount: stretch.length,
      branchIds: hanging.filter((item) => item.chapter === j).map((item) => item.lineId),
      cardMessageIds: stretch.filter((message) => message.kind === "branch_card").map((message) => message.id),
    };
  });
}

/** Splits the chapter a milestone falls in: the new chapter runs from the milestone's message to that chapter's end. */
function split(chapters: readonly Chapter[], milestone: Milestone, chat: readonly Message[]): Chapter[] {
  const seqOf = (id: string) => chat.find((message) => message.id === id)?.seq ?? 0;
  const at = chat.find((message) => message.id === milestone.messageId);
  if (!at) return [...chapters];
  // A milestone on a chapter's first message makes that chapter a milestone one with its name (domain.chapterBoundaries).
  if (chapters.some((chapter) => chapter.startMessageId === at.id)) {
    return chapters.map((chapter) =>
      chapter.startMessageId === at.id ? { ...chapter, kind: "milestone", milestoneId: milestone.id, ...(milestone.title.trim() ? { title: milestone.title, titleSource: "milestone" as const } : {}) } : chapter,
    );
  }
  const index = chapters.reduce((found, chapter, i) => (seqOf(chapter.startMessageId) <= at.seq ? i : found), 0);
  const host = chapters[index];
  if (!host) return [...chapters];
  const nextStart = chapters[index + 1] ? seqOf(chapters[index + 1]!.startMessageId) : Infinity;
  const moved = chat.filter((message) => message.seq >= at.seq && message.seq < nextStart);
  const before = chat.filter((message) => message.seq < at.seq).at(-1);
  const head: Chapter = { ...host, endMessageId: before?.id ?? host.startMessageId, endAt: before?.createdAt ?? host.startAt, messageCount: Math.max(1, host.messageCount - moved.length) };
  const added: Chapter = {
    ...host,
    title: milestone.title,
    titleSource: "milestone",
    kind: "milestone",
    milestoneId: milestone.id,
    startMessageId: at.id,
    startAt: at.createdAt,
    endMessageId: moved.at(-1)?.id ?? at.id,
    endAt: moved.at(-1)?.createdAt ?? at.createdAt,
    messageCount: moved.length,
    branchIds: [],
    cardMessageIds: [],
  };
  return [...chapters.slice(0, index), head, added, ...chapters.slice(index + 1)];
}

export function deriveChapters(messages: readonly Message[], stored: readonly Chapter[], milestones: readonly Milestone[], branches: readonly ChapterBranchRef[] = []): Chapter[] {
  if (stored.length === 0) return computeChapters(messages, milestones, branches);
  const chat = [...messages].filter(isChat).sort((a, b) => a.seq - b.seq);
  const onLine = milestones
    .map((milestone) => ({ milestone, seq: chat.find((message) => message.id === milestone.messageId)?.seq }))
    .filter((item): item is { milestone: Milestone; seq: number } => item.seq !== undefined)
    .sort((a, b) => a.seq - b.seq);
  const chapters = onLine.reduce<Chapter[]>((current, item) => split(current, item.milestone, chat), [...stored]);
  return chapters.map((chapter, index) => ({ ...chapter, index }));
}
