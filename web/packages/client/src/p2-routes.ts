/**
 * Routes and shapes B9 phase A added (docs/devlog/B4-contract-diff.md "B9
 * 增補"): a conversation's goal, relations between nodes, the open-loops
 * review and message pins. Inputs are untrusted JSON; every reader fills the
 * defaults.
 */
import { normalizeBranchView } from "./branch-normalize";
import { normalizeMessage } from "./line-normalize";
import { normalizeSeed, normalizeSuggestion } from "./p1-routes";
import { normalizeNote } from "./result-normalize";
import { normalizeLink } from "./spinoff-routes";
import { GOAL_SOURCES, type BranchView, type Goal, type Link, type Message, type Note, type RelationKind, type Seed, type Suggestion } from "./types";
import { count, isObject, list, num, obj, oneOf, str, strings } from "./wire";

// Inputs -----------------------------------------------------------------------

/** `PUT /lines/{id}/goal`: one line (the server flattens it), at most 300 characters. */
export interface PutGoalInput {
  text: string;
}

/**
 * `POST /lines/{id}/relations`. The start defaults to the path's line and
 * must be in its tree; the end may be any conversation of the tenant. Either
 * end may be a message of its line (a done user / assistant chat message or a
 * conclusion card).
 */
export interface CreateRelationInput {
  fromLineId?: string;
  fromMessageId?: string;
  toLineId: string;
  toMessageId?: string;
  label?: string;
  /** B15; `related` when left out. */
  relationKind?: RelationKind;
}

/** `GET /open-loops`: `root` (any line of a tree) narrows it to one conversation; `staleDays` 1–365, 3 by default. */
export interface OpenLoopsQuery {
  root?: string;
  staleDays?: number;
}

// Results ----------------------------------------------------------------------

/** `GET` / `PUT /goal`: `{goal: null}` when the conversation has none. */
export interface GoalResult {
  goal: Goal | null;
}

/** `GET /relations` limits; the domain defaults when a body lacks them. */
export interface RelationLimits {
  maxPerTree: number;
  labelMaxRunes: number;
}

export const DEFAULT_RELATION_LIMITS: RelationLimits = { maxPerTree: 200, labelMaxRunes: 200 };

/** `GET /lines/{id}/relations`: the tree's relations (links of kind `relation`), with both ends where they are now. */
export interface RelationList {
  relations: Link[];
  limits: RelationLimits;
}

/** `POST /relations`: the relation and every tree it touches (a `link.changed` goes to each). */
export interface RelationWrite {
  relation: Link;
  rootLineIds: string[];
}

/** `POST` / `DELETE /messages/{mid}/pin`. */
export interface PinResult {
  message: Message;
}

/** One group of the review: at most 50 items, `total` counts them all. */
export interface OpenLoopGroup<T> {
  items: T[];
  total: number;
}

export type StaleBranch = BranchView & { rootTitle: string };
export type OpenNote = Note & { rootLineId: string; rootTitle: string };
export type OpenSeed = Seed & { rootTitle: string };
export type OpenSuggestion = Suggestion & { rootTitle: string };

/**
 * `GET /open-loops` (the open_loops feature): what is still unfinished, per
 * conversation or across all of them. Stale branches are always there; the
 * other groups only while their feature is on.
 */
export interface OpenLoops {
  /** "" across all conversations. */
  rootLineId: string;
  staleDays: number;
  /** Open branches without activity for `staleDays`, the longest-idle first. */
  staleBranches: OpenLoopGroup<StaleBranch>;
  /** Active 待確認 notes (notes on). */
  toConfirm?: OpenLoopGroup<OpenNote>;
  /** Open seeds (parking on). */
  seeds?: OpenLoopGroup<OpenSeed>;
  /** Open suggestions of the features that are on. */
  suggestions?: OpenLoopGroup<OpenSuggestion>;
}

// Readers ----------------------------------------------------------------------

export function normalizeGoal(raw: unknown): Goal {
  const goal = obj(raw);
  return {
    rootLineId: str(goal.rootLineId),
    text: str(goal.text),
    source: oneOf(goal.source, GOAL_SOURCES, "manual"),
    updatedBy: str(goal.updatedBy),
    createdAt: str(goal.createdAt),
    updatedAt: str(goal.updatedAt),
  };
}

export function normalizeGoalResult(raw: unknown): GoalResult {
  const body = obj(raw);
  return { goal: isObject(body.goal) ? normalizeGoal(body.goal) : null };
}

export function normalizeRelationList(raw: unknown): RelationList {
  const body = obj(raw);
  const limits = obj(body.limits);
  return {
    relations: list(body.relations, normalizeLink),
    limits: {
      maxPerTree: num(limits.maxPerTree, DEFAULT_RELATION_LIMITS.maxPerTree),
      labelMaxRunes: num(limits.labelMaxRunes, DEFAULT_RELATION_LIMITS.labelMaxRunes),
    },
  };
}

export function normalizeRelationWrite(raw: unknown): RelationWrite {
  const body = obj(raw);
  return { relation: normalizeLink(body.relation), rootLineIds: strings(body.rootLineIds) };
}

export function normalizePinResult(raw: unknown): PinResult {
  return { message: normalizeMessage(obj(raw).message) };
}

function group<T>(raw: unknown, item: (raw: unknown) => T): OpenLoopGroup<T> {
  const body = obj(raw);
  return { items: list(body.items, item), total: count(body.total) };
}

const withRootTitle =
  <T>(read: (raw: unknown) => T) =>
  (raw: unknown): T & { rootTitle: string } => ({ ...read(raw), rootTitle: str(obj(raw).rootTitle) });

const openNote = (raw: unknown): OpenNote => ({ ...normalizeNote(raw), rootLineId: str(obj(raw).rootLineId), rootTitle: str(obj(raw).rootTitle) });

export function normalizeOpenLoops(raw: unknown): OpenLoops {
  const body = obj(raw);
  return {
    rootLineId: str(body.rootLineId),
    staleDays: count(body.staleDays),
    staleBranches: group(body.staleBranches, withRootTitle(normalizeBranchView)),
    ...(isObject(body.toConfirm) ? { toConfirm: group(body.toConfirm, openNote) } : {}),
    ...(isObject(body.seeds) ? { seeds: group(body.seeds, withRootTitle(normalizeSeed)) } : {}),
    ...(isObject(body.suggestions) ? { suggestions: group(body.suggestions, withRootTitle(normalizeSuggestion)) } : {}),
  };
}
