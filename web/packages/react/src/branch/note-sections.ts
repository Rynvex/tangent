import type { NoteSection } from "@tangent/client";
import type { MessageKey } from "../i18n";

/** The four notes sections' names (UI_DESIGN_BRIEF §3: 已決定、已確認的事實、待確認、待辦). */
export const SECTION_KEYS: Record<NoteSection, MessageKey> = {
  decided: "notes.section.decided",
  fact: "notes.section.fact",
  to_confirm: "notes.section.to_confirm",
  todo: "notes.section.todo",
};
