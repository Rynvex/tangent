/**
 * Routes B15 added (DESIGN §12.10): the tree's AI-drafted argument types in
 * one list (`GET /lines/{id}/tag-drafts`). Relation kinds ride on `Link`
 * (spinoff-routes.ts) and a tag's `status` on `PUT /messages/{mid}/tag`.
 * Inputs are untrusted JSON; every reader fills the defaults.
 */
import { normalizeMessageTag } from "./tag-normalize";
import { MESSAGE_ROLES, type MessageRole, type MessageTag } from "./types";
import { bool, count, list, obj, oneOf, str } from "./wire";

/** At most this many drafts; more sets `truncated`. */
export const TAG_DRAFTS_MAX = 500;
/** `domain.TagDraftContentRunes`: each draft's text is cut to this many characters. */
export const TAG_DRAFT_CONTENT_CHARS = 200;

/** One AI draft waiting for the user, with where it is. */
export interface TagDraft {
  lineId: string;
  messageId: string;
  seq: number;
  role: MessageRole;
  /** The start of the message's text (at most `TAG_DRAFT_CONTENT_CHARS`). */
  content: string;
  tag: MessageTag;
}

/** The tree's drafts: the main line first, then branches in outline order, each by `seq`. */
export interface TagDraftList {
  rootLineId: string;
  drafts: TagDraft[];
  truncated: boolean;
}

function normalizeTagDraft(raw: unknown): TagDraft | null {
  const draft = obj(raw);
  const tag = normalizeMessageTag(draft.tag);
  if (!tag) return null;
  return {
    lineId: str(draft.lineId),
    messageId: str(draft.messageId),
    seq: count(draft.seq),
    role: oneOf(draft.role, MESSAGE_ROLES, "assistant"),
    content: str(draft.content),
    tag,
  };
}

export function normalizeTagDraftList(raw: unknown): TagDraftList {
  const body = obj(raw);
  return {
    rootLineId: str(body.rootLineId),
    drafts: list(body.drafts, normalizeTagDraft).filter((draft): draft is TagDraft => draft !== null),
    truncated: bool(body.truncated),
  };
}
