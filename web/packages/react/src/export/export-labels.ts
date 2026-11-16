import type { ExportLabels, FlashcardSource, LeafKind, TreeExportLabels } from "@tangent/client";
import { useMemo } from "react";
import { SECTION_KEYS } from "../branch/note-sections";
import { KIND_KEYS } from "../conversation/branch-suggestions";
import { STATUS_KEYS } from "../conversation/models";
import type { BundleTranslate } from "../i18n/bundle";
import { useExportT, type ExportMessageKey } from "../i18n/export-messages";
import type { MessageKey } from "../i18n";

const LEAF_KEYS: Record<LeafKind, MessageKey> = {
  conclusion: "leaf.kind.conclusion",
  decision: "leaf.kind.decision",
  answer: "leaf.kind.answer",
  dead_end: "leaf.kind.dead_end",
  to_continue: "leaf.kind.to_continue",
};

/** Each flashcard source's name (the dialog's badges use them too). */
export const SOURCE_KEYS: Record<FlashcardSource, ExportMessageKey> = {
  aside: "export.sourceAside",
  fact: "export.sourceFact",
  answer: "export.sourceAnswer",
  term: "export.sourceTerm",
};

/** The generators' words from the export bundle (and the main dictionary for kinds, statuses, sections and leaves). */
export function treeExportLabels(t: BundleTranslate<ExportMessageKey>): TreeExportLabels {
  return {
    truncated: t("exportDoc.truncated"),
    exportedAt: (time) => t("exportDoc.exportedAt", { time }),
    goal: t("exportDoc.goal"),
    notes: t("exportDoc.notes"),
    section: (section) => t(SECTION_KEYS[section] ?? "notes.section.fact"),
    mainLine: t("exportDoc.mainLine"),
    branches: t("exportDoc.branches"),
    user: t("exportDoc.user"),
    ai: t("exportDoc.ai"),
    kind: (kind) => t(KIND_KEYS[kind]),
    status: (status) => t(STATUS_KEYS[status]),
    leafKind: (kind) => t(LEAF_KEYS[kind]),
    forkedFrom: (parent, n) => (n === null ? t("exportDoc.forkedFromLine", { parent }) : t("exportDoc.forkedFrom", { parent, n })),
    card: t("exportDoc.card"),
    cardQuestion: t("exportDoc.cardQuestion"),
    cardConclusion: t("exportDoc.cardConclusion"),
    cardImpact: t("exportDoc.cardImpact"),
    cardOpenItems: t("exportDoc.cardOpenItems"),
    folded: (from, to) => (from === null || to === null ? t("exportDoc.foldedUnnumbered") : t("exportDoc.folded", { from, to })),
    noMessages: t("exportDoc.noMessages"),
    comparisons: t("exportDoc.comparisons"),
    criterion: t("exportDoc.criterion"),
    recommended: (option, reason) => t("exportDoc.recommended", { option, reason }),
    decided: (option) => t("exportDoc.decided", { option }),
    relations: t("exportDoc.relations"),
    relation: (from, to, label) => (label ? t("exportDoc.relation", { from, to, label }) : t("exportDoc.relationUnlabelled", { from, to })),
    memos: t("exportDoc.memos"),
    memosNote: t("exportDoc.memosNote"),
    adrTitle: (title) => t("exportDoc.adrTitle", { title }),
    adrStatus: t("exportDoc.adrStatus"),
    adrStatusDecided: t("exportDoc.adrStatusDecided"),
    adrStatusOpen: t("exportDoc.adrStatusOpen"),
    adrDate: t("exportDoc.adrDate"),
    adrContext: t("exportDoc.adrContext"),
    adrQuestion: t("exportDoc.adrQuestion"),
    adrOptions: t("exportDoc.adrOptions"),
    adrRejected: t("exportDoc.adrRejected"),
    adrDecision: t("exportDoc.adrDecision"),
    adrOpenItems: t("exportDoc.adrOpenItems"),
    adrNone: t("exportDoc.adrNone"),
    cardsTitle: (title) => t("exportDoc.cardsTitle", { title }),
    front: t("exportDoc.front"),
    back: t("exportDoc.back"),
    source: (source) => t(SOURCE_KEYS[source]),
  };
}

/** `TreeExportLabels` in the UI's language. */
export function useTreeExportLabels(): TreeExportLabels {
  const t = useExportT();
  return useMemo(() => treeExportLabels(t), [t]);
}

/** The outline formats' words (the same as the outline's export bar). */
export function outlineExportLabels(t: BundleTranslate<ExportMessageKey>): ExportLabels {
  return { status: (status) => t(STATUS_KEYS[status]), conclusion: t("export.conclusion"), line: t("export.line") };
}
