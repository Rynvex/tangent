/**
 * Shapes B8 phase B added (docs/devlog/B4-contract-diff.md "B8 增補（階段 B）"):
 * spinning a branch or a point off into a new conversation, and the links
 * between conversations. F4 phase 1 only reads them (the contract); the UI
 * comes in phase 2.
 */
import { normalizeBranchView } from "./branch-normalize";
import { normalizeLine, normalizeMessage } from "./line-normalize";
import { normalizeNote } from "./result-normalize";
import { LINK_KINDS, RELATION_KINDS, type BranchView, type Link, type LineView, type Message, type Note } from "./types";
import { count, isObject, list, obj, oneOf, str, strings } from "./wire";

export const SPINOFF_MODES = ["detach", "fresh"] as const;
export type SpinoffMode = (typeof SPINOFF_MODES)[number];

/** `POST /lines/{id}/spinoff`: `detach` an open branch with everything under it, or start `fresh` from a message. */
export interface SpinoffInput {
  mode: SpinoffMode;
  /** Required for `fresh`: a done user / assistant message of the line. */
  atMessageId?: string;
  title?: string;
  copyNotes?: boolean;
}

export interface SpinoffResult {
  mode: SpinoffMode;
  /** The new main line. */
  line: LineView;
  sourceLineId: string;
  /** The tree it came from. */
  rootLineId: string;
  /** The "已獨立 →" marker left on the source line. */
  marker: Message;
  link: Link;
  /** `detach`: the branch as it was. */
  branch?: BranchView;
  moved: string[];
  /** `copyNotes`: the notes copied into the new conversation. */
  notes?: { rootLineId: string; revision: number; created: Note[]; superseded: Note[] };
}

/** `POST /lines/{id}/spinoff/preview` (B8.2): the capsule a spinoff with this body would store; nothing is written. */
export interface SpinoffPreview {
  mode: SpinoffMode;
  capsule: { text: string; tokenEstimate: number; tokenBudget: number; truncated: boolean };
  /** Active notes `copyNotes` would copy (0 without it). */
  notesToCopy: number;
}

export function normalizeSpinoffPreview(raw: unknown): SpinoffPreview {
  const body = obj(raw);
  const capsule = obj(body.capsule);
  return {
    mode: oneOf(body.mode, SPINOFF_MODES, "detach"),
    capsule: { text: str(capsule.text), tokenEstimate: count(capsule.tokenEstimate), tokenBudget: count(capsule.tokenBudget), truncated: capsule.truncated === true },
    notesToCopy: count(body.notesToCopy),
  };
}

export interface LinkList {
  links: Link[];
}

export function normalizeLink(raw: unknown): Link {
  const link = obj(raw);
  const relationKind = "relationKind" in link ? { relationKind: oneOf(link.relationKind, RELATION_KINDS, "related") } : {};
  return {
    id: str(link.id),
    kind: oneOf(link.kind, LINK_KINDS, "spinoff"),
    fromLineId: str(link.fromLineId),
    fromMessageId: str(link.fromMessageId),
    toLineId: str(link.toLineId),
    toMessageId: str(link.toMessageId),
    label: str(link.label),
    ...relationKind,
    fromTitle: str(link.fromTitle),
    toTitle: str(link.toTitle),
    createdBy: str(link.createdBy),
    createdAt: str(link.createdAt),
  };
}

export function normalizeLinkList(raw: unknown): LinkList {
  return { links: list(obj(raw).links, normalizeLink) };
}

export function normalizeSpinoffResult(raw: unknown): SpinoffResult {
  const body = obj(raw);
  const notes = obj(body.notes);
  return {
    mode: oneOf(body.mode, SPINOFF_MODES, "detach"),
    line: normalizeLine(body.line),
    sourceLineId: str(body.sourceLineId),
    rootLineId: str(body.rootLineId),
    marker: normalizeMessage(body.marker),
    link: normalizeLink(body.link),
    ...(isObject(body.branch) ? { branch: normalizeBranchView(body.branch) } : {}),
    moved: strings(body.moved),
    ...(isObject(body.notes)
      ? { notes: { rootLineId: str(notes.rootLineId), revision: count(notes.revision), created: list(notes.created, normalizeNote), superseded: list(notes.superseded, normalizeNote) } }
      : {}),
  };
}
