import { TAG_KINDS, TAG_SOURCES, TAG_STATUSES, type MessageTag, type TagKind } from "./types";
import { isObject, oneOf, str } from "./wire";

/** A tag from the wire (B10 phase A); null without a known kind (a newer server's kind is not shown as another). */
export function normalizeMessageTag(raw: unknown): MessageTag | null {
  if (!isObject(raw) || !(TAG_KINDS as readonly unknown[]).includes(raw.kind)) return null;
  return {
    kind: raw.kind as TagKind,
    source: oneOf(raw.source, TAG_SOURCES, "user"),
    status: oneOf(raw.status, TAG_STATUSES, "confirmed"),
    updatedAt: str(raw.updatedAt),
  };
}
