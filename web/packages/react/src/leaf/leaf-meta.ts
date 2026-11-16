import type { LeafKind } from "@tangent/client";
import { Ban, CornerDownRight, Flag, Gavel, Hourglass, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../i18n";

/** The kind's icon (the prototype's LEAF table). */
export const LEAF_ICONS: Readonly<Record<LeafKind, LucideIcon>> = {
  conclusion: Flag,
  decision: Gavel,
  answer: CornerDownRight,
  dead_end: Ban,
  to_continue: Hourglass,
};

/** The kind's semantic colour (tokens.css leaf-*, ≥ 4.5:1 on every surface). */
export const LEAF_TEXT: Readonly<Record<LeafKind, string>> = {
  conclusion: "text-tg-leaf-conclusion",
  decision: "text-tg-leaf-decision",
  answer: "text-tg-leaf-answer",
  dead_end: "text-tg-leaf-deadend",
  to_continue: "text-tg-leaf-pending",
};

export const LEAF_KIND_KEYS: Readonly<Record<LeafKind, MessageKey>> = {
  conclusion: "leaf.kind.conclusion",
  decision: "leaf.kind.decision",
  answer: "leaf.kind.answer",
  dead_end: "leaf.kind.dead_end",
  to_continue: "leaf.kind.to_continue",
};
