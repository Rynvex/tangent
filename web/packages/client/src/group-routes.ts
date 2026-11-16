/**
 * Routes and shapes B9 phase C added (docs/devlog/B4-contract-diff.md "B9
 * 增補（階段 C）"): groups of ended branches with a shared summary, combining
 * open sibling branches into one, conflicts and the choices made about them,
 * a relation's label, and the generic `job.failed` event's payload.
 */
import type { BranchKind, BranchPack, BranchView, LineView, Note, RelationKind } from "./types";
import type { JobStarted } from "./api-types";
import { normalizeBranchPack, normalizeBranchView } from "./branch-normalize";
import { normalizeLine } from "./line-normalize";
import { normalizeNote } from "./result-normalize";
import { count, isObject, list, num, obj, oneOf, str, strings } from "./wire";

export const GROUP_STATUSES = ["active", "dissolved"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];
export const GROUP_SUMMARY_STATUSES = ["none", "drafting", "ready", "failed"] as const;
/** `failed` keeps the previous summary. */
export type GroupSummaryStatus = (typeof GROUP_SUMMARY_STATUSES)[number];

/** Ended branches of one tree gathered under one shared summary (C2); they reach the prompt only through fisheye. */
export interface Group {
  id: string;
  rootLineId: string;
  /** At most 120 characters. */
  title: string;
  /** The shared summary (≤ 1000 characters, may be several lines); "" until written. */
  summary: string;
  summaryStatus: GroupSummaryStatus;
  status: GroupStatus;
  /** In the order the branches were opened. */
  memberLineIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const CONFLICT_CHOICES = ["adoptBranch", "adoptOther", "keepBoth"] as const;
/** 採用這條 / 採用另一條 / 都保留（keepBoth writes a 待確認 note and needs notes on）. */
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];

/** Two members that say different things. */
export interface Conflict {
  /** Optional in a request (c1, c2…); always set in a suggestion. */
  id?: string;
  branch: { lineId: string; claim: string };
  other: { lineId: string; claim: string };
  /** Required in a request; absent in a suggestion. */
  choice?: ConflictChoice;
}

export interface GroupLimits {
  maxMembers: number;
  maxActivePerTree: number;
  titleMaxRunes: number;
}

export const DEFAULT_GROUP_LIMITS: GroupLimits = { maxMembers: 12, maxActivePerTree: 50, titleMaxRunes: 120 };
/** domain limits: a group or a combine takes 2–12 branches. */
export const GROUP_MIN_MEMBERS = 2;

export interface GroupList {
  rootLineId: string;
  groups: Group[];
  limits: GroupLimits;
}

export interface NotesApplied {
  rootLineId: string;
  revision: number;
  created: Note[];
  superseded: Note[];
}

/** `POST /groups`: the group (its summary already drafting) and the job, or null; the keepBoth notes when any. */
export interface GroupWrite {
  group: Group;
  job: JobStarted | null;
  notes?: NotesApplied;
}

/** `POST /branches/combine`: the new branch (origin `merge`), and the branches it replaced (discarded, `mergedIntoLineId`). */
export interface CombineResult {
  line: LineView;
  branch: BranchView;
  pack: BranchPack;
  combined: BranchView[];
  notes?: NotesApplied;
  /** B9.1: the combined branches' open children, now hanging on the new branch (anchors and depths kept), in id order. */
  reparented: string[];
}

// Inputs -----------------------------------------------------------------------

/** `?status=` of `GET /groups`: comma-separated or `all`; the server's default is `active`. */
export interface GroupListQuery {
  status?: string;
}

export interface CreateGroupInput {
  memberLineIds: string[];
  title: string;
  /** Each with its choice. */
  conflicts?: Conflict[];
}

export interface RenameGroupInput {
  title: string;
}

/** `{id}` of the route is the parent line; the branches are its open, non-aside children. */
export interface CombineBranchesInput {
  lineIds: string[];
  purpose: string;
  kind?: BranchKind;
  conflicts?: Conflict[];
}

/** `PATCH /relations/{rid}`: a field left out keeps its stored value (B15). */
export interface UpdateRelationInput {
  label?: string;
  relationKind?: RelationKind;
}

/** The body that accepts a group suggestion: what to do (by default, group when two members ended) and the choices by conflict id. */
export interface GroupAcceptBody {
  action?: "group" | "combine";
  title?: string;
  purpose?: string;
  kind?: BranchKind;
  choices?: Readonly<Record<string, ConflictChoice>>;
}

// Readers ----------------------------------------------------------------------

export function normalizeGroup(raw: unknown): Group {
  const group = obj(raw);
  return {
    id: str(group.id),
    rootLineId: str(group.rootLineId),
    title: str(group.title),
    summary: str(group.summary),
    summaryStatus: oneOf(group.summaryStatus, GROUP_SUMMARY_STATUSES, "none"),
    status: oneOf(group.status, GROUP_STATUSES, "active"),
    memberLineIds: strings(group.memberLineIds),
    createdBy: str(group.createdBy),
    createdAt: str(group.createdAt),
    updatedAt: str(group.updatedAt),
  };
}

export function normalizeGroupList(raw: unknown): GroupList {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    rootLineId: str(body.rootLineId),
    groups: list(body.groups, normalizeGroup),
    limits: {
      maxMembers: num(limits.maxMembers, DEFAULT_GROUP_LIMITS.maxMembers),
      maxActivePerTree: num(limits.maxActivePerTree, DEFAULT_GROUP_LIMITS.maxActivePerTree),
      titleMaxRunes: num(limits.titleMaxRunes, DEFAULT_GROUP_LIMITS.titleMaxRunes),
    },
  };
}

export function normalizeGroupResult(raw: unknown): { group: Group } {
  return { group: normalizeGroup(obj(raw).group) };
}

function normalizeNotesApplied(raw: unknown): NotesApplied | undefined {
  if (!isObject(raw)) return undefined;
  return { rootLineId: str(raw.rootLineId), revision: count(raw.revision), created: list(raw.created, normalizeNote), superseded: list(raw.superseded, normalizeNote) };
}

function normalizeJob(raw: unknown): JobStarted | null {
  if (!isObject(raw)) return null;
  return {
    jobId: str(raw.jobId),
    kind: str(raw.kind),
    lineId: str(raw.lineId),
    ...(typeof raw.provider === "string" ? { provider: raw.provider } : {}),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
  };
}

export function normalizeGroupWrite(raw: unknown): GroupWrite {
  const body = obj(raw);
  const notes = normalizeNotesApplied(body.notes);
  return { group: normalizeGroup(body.group), job: normalizeJob(body.job), ...(notes ? { notes } : {}) };
}

export function normalizeCombineResult(raw: unknown): CombineResult {
  const body = obj(raw);
  const notes = normalizeNotesApplied(body.notes);
  return {
    line: normalizeLine(body.line),
    branch: normalizeBranchView(body.branch),
    pack: normalizeBranchPack(body.pack),
    combined: list(body.combined, normalizeBranchView),
    ...(notes ? { notes } : {}),
    reparented: strings(body.reparented),
  };
}

export function normalizeConflict(raw: unknown): Conflict {
  const conflict = obj(raw);
  const side = (value: unknown) => ({ lineId: str(obj(value).lineId), claim: str(obj(value).claim) });
  const choice = conflict.choice;
  return {
    ...(typeof conflict.id === "string" ? { id: conflict.id } : {}),
    branch: side(conflict.branch),
    other: side(conflict.other),
    ...(typeof choice === "string" && (CONFLICT_CHOICES as readonly string[]).includes(choice) ? { choice: choice as ConflictChoice } : {}),
  };
}

// The generic job failure (B9 phase C) -----------------------------------------------

export const JOB_ERROR_CODES = ["run_failed", "unusable", "timed_out", "failed"] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

/** `job.failed`: a background job (goal proposal, drift check, relation or group suggestion, group summary) failed or timed out. */
export interface JobFailed {
  jobId: string;
  kind: string;
  lineId: string;
  rootLineId: string;
  error: { code: JobErrorCode; message: string };
}

export function normalizeJobFailed(raw: unknown): JobFailed {
  const body = obj(raw);
  const error = obj(body.error);
  return {
    jobId: str(body.jobId),
    kind: str(body.kind),
    lineId: str(body.lineId),
    rootLineId: str(body.rootLineId),
    error: { code: oneOf(error.code, JOB_ERROR_CODES, "failed"), message: str(error.message) },
  };
}
