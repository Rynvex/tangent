import type { ChapterLimitsView, ChaptersView, MilestoneWriteResult } from "./api-types";
import { TangentError, extraNumber } from "./errors";
import type { HostErrorText, TranslateFn } from "./i18n-keys";
import { CHAPTER_KINDS, CHAPTER_TITLE_SOURCES, type Chapter, type Milestone } from "./types";
import { count, list, num, obj, oneOf, str, strings } from "./wire";

export { chapterRange, chaptersByStart, chapterTitle } from "./chapter-display";

/** Contract limits (domain.DefaultLimits), used until the server's own arrive. */
export const DEFAULT_CHAPTER_LIMITS: ChapterLimitsView = {
  maxChapters: 60,
  minMessages: 3,
  idleGapMinutes: 30,
  maxMilestones: 200,
  milestoneMaxLen: 80,
};

function positive(value: unknown, fallback: number): number {
  return count(value) || fallback;
}

function normalizeChapter(raw: unknown, position: number): Chapter {
  const chapter = obj(raw);
  return {
    index: num(chapter.index, position),
    title: str(chapter.title),
    titleSource: oneOf(chapter.titleSource, CHAPTER_TITLE_SOURCES, "time"),
    kind: oneOf(chapter.kind, CHAPTER_KINDS, "start"),
    milestoneId: str(chapter.milestoneId),
    startMessageId: str(chapter.startMessageId),
    endMessageId: str(chapter.endMessageId),
    startAt: str(chapter.startAt),
    endAt: str(chapter.endAt),
    messageCount: count(chapter.messageCount),
    branchIds: strings(chapter.branchIds),
    cardMessageIds: strings(chapter.cardMessageIds),
  };
}

/** 201 body of `POST /chapters/milestones`. */
export function normalizeMilestoneWrite(raw: unknown): MilestoneWriteResult {
  const body = obj(raw);
  return { milestone: normalizeMilestone(body.milestone), rootLineId: str(body.rootLineId) };
}

export function normalizeMilestone(raw: unknown): Milestone {
  const milestone = obj(raw);
  return {
    id: str(milestone.id),
    messageId: str(milestone.messageId),
    kind: str(milestone.kind) || "milestone",
    title: str(milestone.title),
    createdBy: str(milestone.createdBy),
    createdAt: str(milestone.createdAt),
  };
}

/** Fills the fields an older server or a fixture leaves out, so the UI never reads `undefined`. */
export function normalizeChapters(raw: unknown): ChaptersView {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    lineId: str(body.lineId),
    rootLineId: str(body.rootLineId),
    chapters: list(body.chapters, normalizeChapter),
    milestones: list(body.milestones, normalizeMilestone),
    limits: {
      maxChapters: positive(limits.maxChapters, DEFAULT_CHAPTER_LIMITS.maxChapters),
      minMessages: positive(limits.minMessages, DEFAULT_CHAPTER_LIMITS.minMessages),
      idleGapMinutes: positive(limits.idleGapMinutes, DEFAULT_CHAPTER_LIMITS.idleGapMinutes),
      maxMilestones: positive(limits.maxMilestones, DEFAULT_CHAPTER_LIMITS.maxMilestones),
      milestoneMaxLen: positive(limits.milestoneMaxLen, DEFAULT_CHAPTER_LIMITS.milestoneMaxLen),
    },
  };
}

/** The manual milestone anchored on a message, if any. */
export function milestoneOn(milestones: readonly Milestone[], messageId: string): Milestone | undefined {
  return milestones.find((item) => item.messageId === messageId);
}

export interface DescribeChapterErrorOptions {
  limits?: ChapterLimitsView;
  /** The host's own text for a code (DESIGN §12); only asked for codes without a built-in message. */
  hostText?: HostErrorText;
}

/** Localised text for a failed milestone call; 403 means the host refused a write. */
export function describeChapterError(error: unknown, t: TranslateFn, options: DescribeChapterErrorOptions = {}): string {
  const limits = options.limits ?? DEFAULT_CHAPTER_LIMITS;
  if (!(error instanceof TangentError)) return t("chapters.errorUnknown");
  switch (error.code) {
    case "message_not_found":
      return t("chapters.errorMessageNotFound");
    case "milestone_not_found":
      return t("chapters.errorMilestoneNotFound");
    case "milestone_exists":
      return t("chapters.errorExists");
    case "milestone_limit":
      return t("chapters.errorLimit", { max: extraNumber(error, "maxMilestones", limits.maxMilestones) });
    case "archived":
      return t("chapters.errorArchived");
    case "invalid_milestone":
      return t("chapters.errorInvalid", { max: extraNumber(error, "maxLength", limits.milestoneMaxLen) });
    default: {
      const host = error.code ? options.hostText?.(error.code) : undefined;
      if (host) return host;
      if (error.status === 403) return t("chapters.errorViewer");
      return error.message || t("chapters.errorUnknown");
    }
  }
}
