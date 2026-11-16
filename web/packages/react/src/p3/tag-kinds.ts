import type { TagKind } from "@tangent/client";

/** The main dictionary's name of each argument type (the outline and the map use it too). */
export const TAG_KIND_KEYS = {
  question: "tag.kind.question",
  idea: "tag.kind.idea",
  pro: "tag.kind.pro",
  con: "tag.kind.con",
  decision: "tag.kind.decision",
} as const satisfies Record<TagKind, string>;

/** Label = argument type (handoff §9-7): each kind's own token, for the text and the border. */
export const TAG_TEXT: Record<TagKind, string> = {
  question: "text-tg-arg-question border-tg-arg-question",
  idea: "text-tg-arg-idea border-tg-arg-idea",
  pro: "text-tg-arg-pro border-tg-arg-pro",
  con: "text-tg-arg-con border-tg-arg-con",
  decision: "text-tg-arg-decision border-tg-arg-decision",
};
