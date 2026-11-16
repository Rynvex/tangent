/**
 * The data a mock client starts from, and builders that fill every field
 * through the same normalizers the real client uses — so fixtures can stay
 * short and still have the exact wire shape.
 */
import type { ChapterLimitsView, NoteLimitsView } from "../api-types";
import { normalizeBranchCard, normalizeBranchView } from "../branch-normalize";
import type { Capabilities } from "../capabilities";
import type { Memo } from "../memo-routes";
import type { Term } from "../glossary-routes";
import { DEFAULT_CHAPTER_LIMITS, normalizeChapters } from "../chapters";
import { normalizeLine, normalizeMessage } from "../line-normalize";
import { DEFAULT_NOTE_LIMITS, normalizeNote } from "../result-normalize";
import type { BranchCard, BranchView, Chapter, Goal, Leaf, LineView, Message, Milestone, Note, Seed, Suggestion } from "../types";
import { MOCK_NOTES_TOKEN_BUDGET } from "./mock-notes-block";

export interface MockChapters {
  chapters: Chapter[];
  milestones: Milestone[];
}

/** Everything the mock serves. Messages carry their `lineId`; notes and chapters are per main line. */
export interface MockScenario {
  lines: LineView[];
  messages: Message[];
  branches: BranchView[];
  /** Conclusion cards a draft would propose, per branch line (for `getBranch` / `startDraft`). */
  draftCards: Record<string, BranchCard>;
  notesByRoot: Record<string, Note[]>;
  chaptersByLine: Record<string, MockChapters>;
  capabilities: Capabilities;
  /** `tokenBudget` is also the notes block's budget in the mock's previews. */
  noteLimits: NoteLimitsView;
  chapterLimits: ChapterLimitsView;
  /** What the assistant streams back, per main line id; `"*"` is the fallback. */
  replies: Record<string, string>;
  /** B8: leaves per branch line (their summary must match the branch view's `leaf`), parked seeds, suggestions. */
  leaves?: Record<string, Leaf>;
  seeds?: Seed[];
  /** B13: memos (not sent to the AI). */
  memos?: Memo[];
  /** B24: glossary terms, of any conversation. */
  terms?: Term[];
  suggestions?: Suggestion[];
  /** B9: goals per main line, and what an AI goal proposal says per main line (`"*"` is the fallback). */
  goals?: Record<string, Goal>;
  goalProposals?: Record<string, string>;
  /** The scenario's present (open loops measure staleness from it); the client's clock when absent. */
  now?: string;
}

/** Builders: partial wire JSON in, complete objects out. */
export const fixture = {
  line: (raw: Record<string, unknown>): LineView => normalizeLine(raw),
  message: (raw: Record<string, unknown>): Message => normalizeMessage(raw),
  branch: (raw: Record<string, unknown>): BranchView => normalizeBranchView(raw),
  note: (raw: Record<string, unknown>): Note => normalizeNote(raw),
  card: (raw: Record<string, unknown>): BranchCard => {
    const card = normalizeBranchCard(raw);
    if (!card) throw new Error("fixture card is not an object");
    return card;
  },
  chapters: (lineId: string, raw: Record<string, unknown>): MockChapters => {
    const view = normalizeChapters({ lineId, rootLineId: lineId, ...raw });
    return { chapters: view.chapters, milestones: view.milestones };
  },
};

export const MOCK_NOTE_LIMITS: NoteLimitsView = { ...DEFAULT_NOTE_LIMITS, tokenBudget: MOCK_NOTES_TOKEN_BUDGET };
export const MOCK_CHAPTER_LIMITS: ChapterLimitsView = { ...DEFAULT_CHAPTER_LIMITS };
