/**
 * What the export dialog writes from a whole tree (`GET /lines/{id}/export`,
 * B14): a full report, a backup, an architecture decision record and
 * flashcards. Pure functions; every human word comes from `TreeExportLabels`,
 * so a host or locale words them. Message bodies stay Markdown, but a line
 * of theirs never becomes a heading of the file.
 */
import { NOTE_SECTIONS } from "./aside-note";
import { EXPORT_MAX_MESSAGES_PER_LINE, type TreeExport } from "./b14-routes";
import { singleLine } from "./branch-export";
import { buildBranchTree, type BranchNode } from "./branch-tree";
import { chatMessages, isHostNotice } from "./branch-view";
import type { Comparison } from "./comparison-routes";
import type { BranchKind, BranchStatus, BranchView, LeafKind, Message, Note, NoteSection } from "./types";

export interface TreeExportLabels {
  /** The line at the top of a file made from a truncated export. */
  truncated: string;
  exportedAt: (time: string) => string;
  goal: string;
  notes: string;
  section: (section: NoteSection) => string;
  mainLine: string;
  branches: string;
  user: string;
  ai: string;
  kind: (kind: BranchKind) => string;
  status: (status: BranchStatus) => string;
  leafKind: (kind: LeafKind) => string;
  /** Where a branch forks: "From the main line #6", "From “parent” #2"; `n` is null when unknown. */
  forkedFrom: (parent: string, n: number | null) => string;
  /** A conclusion card in a transcript. */
  card: string;
  cardQuestion: string;
  cardConclusion: string;
  cardImpact: string;
  cardOpenItems: string;
  /** A folded run: "Folded #3–#6 (AI gets this summary)". */
  folded: (from: number | null, to: number | null) => string;
  noMessages: string;
  comparisons: string;
  criterion: string;
  recommended: (option: string, reason: string) => string;
  decided: (option: string) => string;
  relations: string;
  relation: (from: string, to: string, label: string) => string;
  memos: string;
  /** Said with the memos: they never went to the AI. */
  memosNote: string;
  // ADR
  adrTitle: (title: string) => string;
  adrStatus: string;
  adrStatusDecided: string;
  adrStatusOpen: string;
  adrDate: string;
  adrContext: string;
  adrQuestion: string;
  adrOptions: string;
  adrRejected: string;
  adrDecision: string;
  adrOpenItems: string;
  adrNone: string;
  // Flashcards
  cardsTitle: (title: string) => string;
  front: string;
  back: string;
  source: (source: FlashcardSource) => string;
}

export interface TreeReportOptions {
  /** Memos per node, marked as never sent to the AI. */
  includeMemos: boolean;
  /** Discarded branches and dead ends (with what hangs under them). */
  includeEnded: boolean;
}

const MAX_HEADING_LEVEL = 6;
const BRANCH_HEADING_LEVEL = 3;
const QUESTION_MAX = 300;

/** Characters that would turn one-line user text into Markdown structure (a `#` only where it could open or close a heading). */
function inlineEscape(text: string): string {
  return singleLine(text, Number.POSITIVE_INFINITY)
    .replace(/[\\`*_{}[\]<>|]/g, "\\$&")
    .replace(/^#/, "\\#")
    .replace(/(\s)(#+)$/, "$1\\$2");
}

/** A heading's text: one line, Markdown characters escaped (a leading `#` is plain text after the marker). */
const heading = (level: number, text: string) => `${"#".repeat(Math.min(level, MAX_HEADING_LEVEL))} ${inlineEscape(text).replace(/^\\#/, "#")}`;

/**
 * A message body kept as Markdown, except that a line starting like a heading
 * (or a setext underline) is escaped outside code fences, so it cannot open a
 * section of the file.
 */
export function quoteBody(text: string): string {
  let fence: string | null = null;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (fence === null) fence = marker[0]!;
        else if (marker[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return line.replace(/#/, "\\#");
      if (/^\s{0,3}(=+|-{2,})\s*$/.test(line)) return `\\${line.trimStart()}`;
      return line;
    })
    .join("\n")
    .trim();
}

const isDeadEnd = (branch: BranchView) => branch.status === "discarded" || branch.leaf?.kind === "dead_end";

/** The outline, depth first in outline order, without ended subtrees when asked. */
function walk(nodes: readonly BranchNode[], includeEnded: boolean, depth = 0): Array<{ branch: BranchView; depth: number }> {
  return nodes.flatMap((node) => (!includeEnded && isDeadEnd(node.branch) ? [] : [{ branch: node.branch, depth }, ...walk(node.children, includeEnded, depth + 1)]));
}

function messagesOf(tree: TreeExport, lineId: string): Message[] {
  return [...(tree.messagesByLine[lineId] ?? [])].sort((a, b) => a.seq - b.seq);
}

const activeNotes = (tree: TreeExport) => tree.notes.filter((note) => note.status === "active");

function notesBlock(notes: readonly Note[], labels: TreeExportLabels): string[] {
  if (notes.length === 0) return [];
  const sections = NOTE_SECTIONS.flatMap((section) => {
    const items = notes.filter((note) => note.section === section);
    return items.length === 0 ? [] : [heading(3, labels.section(section)), "", ...items.map((note) => `- ${inlineEscape(note.text)}`), ""];
  });
  return [heading(2, labels.notes), "", ...sections];
}

function cardBlock(message: Message, labels: TreeExportLabels): string[] {
  const card = message.meta.card;
  if (!card) return [`> **${inlineEscape(labels.card)}**`, ""];
  const rows = [
    `> **${inlineEscape(labels.card)}**`,
    ...(card.question ? [`> ${inlineEscape(labels.cardQuestion)}: ${inlineEscape(card.question)}`] : []),
    `> ${inlineEscape(labels.cardConclusion)}: ${inlineEscape(card.conclusion)}`,
    ...(card.impact ? [`> ${inlineEscape(labels.cardImpact)}: ${inlineEscape(card.impact)}`] : []),
    ...(card.openItems.length > 0 ? [`> ${inlineEscape(labels.cardOpenItems)}: ${card.openItems.map(inlineEscape).join("; ")}`] : []),
  ];
  return [rows.join("\n>\n"), ""];
}

/** One line's transcript: numbered chat messages, cards, markers, and a note before each folded run. */
function transcript(tree: TreeExport, lineId: string, labels: TreeExportLabels, level: number): string[] {
  const messages = messagesOf(tree, lineId).filter((message) => !isHostNotice(message));
  if (messages.length === 0) return [`_${inlineEscape(labels.noMessages)}_`, ""];
  const numbers = new Map(chatMessages(messages).map((message, index) => [message.id, index + 1]));
  const folds = new Map((tree.foldsByLine[lineId] ?? []).map((fold) => [fold.fromMessageId, fold]));
  return messages.flatMap((message) => {
    const fold = folds.get(message.id);
    const foldNote = fold ? [`> ${inlineEscape(labels.folded(numbers.get(fold.fromMessageId) ?? null, numbers.get(fold.toMessageId) ?? null))}${fold.summary ? `: ${inlineEscape(fold.summary)}` : ""}`, ""] : [];
    if (message.kind === "branch_card") return [...foldNote, ...cardBlock(message, labels)];
    if (message.kind === "branch_marker") return [...foldNote, `_${inlineEscape(message.content)}_`, ""];
    const who = message.role === "user" ? labels.user : labels.ai;
    const n = numbers.get(message.id);
    return [...foldNote, heading(level, `${n ? `#${n} ` : ""}${who}`), "", quoteBody(message.content), ""];
  });
}

function memosBlock(tree: TreeExport, lineId: string, labels: TreeExportLabels, level: number): string[] {
  const memos = tree.memos.filter((memo) => memo.lineId === lineId);
  if (memos.length === 0) return [];
  return [heading(level, labels.memos), "", `_${inlineEscape(labels.memosNote)}_`, "", ...memos.map((memo) => `- ${inlineEscape(memo.text)}`), ""];
}

function branchName(tree: TreeExport, lineId: string, labels: TreeExportLabels): string {
  if (lineId === tree.rootLineId) return labels.mainLine;
  return tree.branches.find((branch) => branch.lineId === lineId)?.purpose ?? lineId;
}

function forkLine(tree: TreeExport, branch: BranchView, labels: TreeExportLabels): string {
  const parent = messagesOf(tree, branch.parentLineId);
  const n = chatMessages(parent).findIndex((message) => message.id === branch.anchorMessageId);
  return labels.forkedFrom(branchName(tree, branch.parentLineId, labels), n >= 0 ? n + 1 : null);
}

function branchBlock(tree: TreeExport, branch: BranchView, depth: number, labels: TreeExportLabels, options: TreeReportOptions): string[] {
  const level = BRANCH_HEADING_LEVEL + depth;
  const facts = [labels.kind(branch.kind), labels.status(branch.status), forkLine(tree, branch, labels)].map(inlineEscape).join(" · ");
  const result = branch.leaf ? `**${inlineEscape(labels.leafKind(branch.leaf.kind))}**: ${inlineEscape(branch.leaf.line)}` : branch.conclusionLine ? `**${inlineEscape(labels.cardConclusion)}**: ${inlineEscape(branch.conclusionLine)}` : "";
  return [
    heading(level, branch.purpose),
    "",
    `_${facts}_`,
    "",
    ...(result ? [result, ""] : []),
    ...transcript(tree, branch.lineId, labels, level + 1),
    ...(options.includeMemos ? memosBlock(tree, branch.lineId, labels, level + 1) : []),
  ];
}

function optionLabel(comparison: Comparison, lineId: string, tree: TreeExport): string {
  return comparison.matrix?.options.find((option) => option.lineId === lineId)?.label || tree.branches.find((branch) => branch.lineId === lineId)?.purpose || lineId;
}

/** A comparison's table: criteria rows, one column per option, scores 1–5 ("—" for none). */
export function comparisonTable(comparison: Comparison, tree: TreeExport, labels: TreeExportLabels): string[] {
  const matrix = comparison.matrix;
  if (!matrix) return [];
  const cell = (text: string) => inlineEscape(text) || " ";
  const head = `| ${cell(labels.criterion)} | ${matrix.options.map((option) => cell(option.label)).join(" | ")} |`;
  const rule = `|${" --- |".repeat(matrix.options.length + 1)}`;
  const rows = matrix.criteria.map((criterion, row) => `| ${cell(criterion)} | ${matrix.options.map((_option, column) => String(matrix.scores[row]?.[column]?.score || "—")).join(" | ")} |`);
  const notes = [
    ...(matrix.recommendation.lineId ? [labels.recommended(optionLabel(comparison, matrix.recommendation.lineId, tree), matrix.recommendation.reason)] : []),
    ...(comparison.decidedLineId ? [labels.decided(optionLabel(comparison, comparison.decidedLineId, tree))] : []),
  ];
  return [head, rule, ...rows, "", ...notes.map((note) => `- ${inlineEscape(note)}`), ...(notes.length > 0 ? [""] : [])];
}

function relationsBlock(tree: TreeExport, labels: TreeExportLabels): string[] {
  const relations = tree.links.filter((link) => link.kind === "relation");
  if (relations.length === 0) return [];
  return [heading(2, labels.relations), "", ...relations.map((link) => `- ${inlineEscape(labels.relation(link.fromTitle || link.fromLineId, link.toTitle || link.toLineId, link.label))}`), ""];
}

const truncation = (tree: TreeExport, labels: TreeExportLabels) => (tree.truncated ? [`> ${inlineEscape(labels.truncated)}`, ""] : []);
const titleOf = (tree: TreeExport) => tree.rootLine.title || tree.rootLineId;

/** 完整研究報告 (.md): goal, notes, the main line and every branch with their messages, comparisons and relations. */
export function treeReportMarkdown(tree: TreeExport, labels: TreeExportLabels, options: TreeReportOptions): string {
  const branches = walk(buildBranchTree(tree.branches), options.includeEnded);
  const comparisons = tree.comparisons.filter((comparison) => comparison.matrix);
  const lines = [
    ...truncation(tree, labels),
    heading(1, titleOf(tree)),
    "",
    `_${inlineEscape(labels.exportedAt(tree.exportedAt))}_`,
    "",
    ...(tree.goal ? [heading(2, labels.goal), "", inlineEscape(tree.goal.text), ""] : []),
    ...notesBlock(activeNotes(tree), labels),
    heading(2, labels.mainLine),
    "",
    ...transcript(tree, tree.rootLineId, labels, BRANCH_HEADING_LEVEL),
    ...(options.includeMemos ? memosBlock(tree, tree.rootLineId, labels, BRANCH_HEADING_LEVEL) : []),
    ...(branches.length > 0 ? [heading(2, labels.branches), "", ...branches.flatMap(({ branch, depth }) => branchBlock(tree, branch, depth, labels, options))] : []),
    ...(comparisons.length > 0 ? [heading(2, labels.comparisons), "", ...comparisons.flatMap((comparison) => comparisonTable(comparison, tree, labels))] : []),
    ...relationsBlock(tree, labels),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** 完整備份 (.json): the export exactly as the server sent it (normalized). */
export function treeBackupJson(tree: TreeExport): string {
  return `${JSON.stringify(tree, null, 2)}\n`;
}

function bullet(text: string): string {
  return `- ${text}`;
}

const resultOf = (branch: BranchView) => branch.leaf?.line || branch.conclusionLine;

/** ADR (.md): context, the options weighed, what was rejected and why, the decision and what is still open. */
export function treeAdrMarkdown(tree: TreeExport, labels: TreeExportLabels): string {
  const branches = tree.branches.filter((branch) => branch.kind !== "aside");
  const rejected = branches.filter(isDeadEnd);
  const weighed = branches.filter((branch) => !isDeadEnd(branch));
  const notes = activeNotes(tree);
  const question = chatMessages(messagesOf(tree, tree.rootLineId)).find((message) => message.role === "user")?.content ?? "";
  const decisions = [
    ...tree.comparisons.filter((comparison) => comparison.decidedLineId).map((comparison) => labels.decided(optionLabel(comparison, comparison.decidedLineId, tree))),
    ...branches.filter((branch) => branch.leaf?.kind === "decision").map((branch) => `${branch.purpose}: ${branch.leaf?.line ?? ""}`),
    ...notes.filter((note) => note.section === "decided").map((note) => note.text),
  ];
  const open = [...notes.filter((note) => note.section === "todo" || note.section === "to_confirm").map((note) => note.text), ...branches.filter((branch) => branch.status === "open").map((branch) => branch.purpose)];
  const none = [bullet(inlineEscape(labels.adrNone))];
  const lines = [
    ...truncation(tree, labels),
    heading(1, labels.adrTitle(titleOf(tree))),
    "",
    bullet(`**${inlineEscape(labels.adrStatus)}**: ${inlineEscape(decisions.length > 0 ? labels.adrStatusDecided : labels.adrStatusOpen)}`),
    bullet(`**${inlineEscape(labels.adrDate)}**: ${inlineEscape(tree.exportedAt.slice(0, 10))}`),
    "",
    heading(2, labels.adrContext),
    "",
    ...(tree.goal ? [bullet(`**${inlineEscape(labels.goal)}**: ${inlineEscape(tree.goal.text)}`)] : []),
    ...(question ? [bullet(`**${inlineEscape(labels.adrQuestion)}**: ${inlineEscape(singleLine(question, QUESTION_MAX))}`)] : []),
    ...(!tree.goal && !question ? none : []),
    "",
    heading(2, labels.adrOptions),
    "",
    ...(weighed.length > 0
      ? weighed.map((branch) => bullet(`**${inlineEscape(branch.purpose)}** (${inlineEscape(`${labels.kind(branch.kind)} · ${labels.status(branch.status)}`)})${resultOf(branch) ? ` — ${inlineEscape(resultOf(branch))}` : ""}`))
      : none),
    "",
    ...tree.comparisons.flatMap((comparison) => comparisonTable(comparison, tree, labels)),
    heading(2, labels.adrRejected),
    "",
    ...(rejected.length > 0 ? rejected.map((branch) => bullet(`**${inlineEscape(branch.purpose)}** — ${inlineEscape(resultOf(branch) || labels.status(branch.status))}`)) : none),
    "",
    heading(2, labels.adrDecision),
    "",
    ...(decisions.length > 0 ? decisions.map((text) => bullet(inlineEscape(text))) : none),
    "",
    heading(2, labels.adrOpenItems),
    "",
    ...(open.length > 0 ? open.map((text) => bullet(inlineEscape(text))) : none),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// Flashcards -------------------------------------------------------------------

/** `term` (B24): a glossary term, its explanation on the back. */
export const FLASHCARD_SOURCES = ["aside", "fact", "answer", "term"] as const;
export type FlashcardSource = (typeof FLASHCARD_SOURCES)[number];

export interface Flashcard {
  front: string;
  back: string;
  source: FlashcardSource;
  /** The line the card came from (the note's source line for a fact; "" when it has none). */
  lineId: string;
  messageId?: string;
}

/** An aside's question and answer: its first user message and the first finished reply after it. */
function asideCard(tree: TreeExport, branch: BranchView): Flashcard | null {
  const chat = chatMessages(messagesOf(tree, branch.lineId));
  const question = chat.find((message) => message.role === "user");
  const answer = question && chat.find((message) => message.role === "assistant" && message.status === "done" && message.seq > question.seq);
  if (!question || !answer || !question.content.trim() || !answer.content.trim()) return null;
  return { front: question.content.trim(), back: answer.content.trim(), source: "aside", lineId: branch.lineId, messageId: question.id };
}

/**
 * Cards of a tree: every aside's question → answer; every active fact note
 * (front: where it came from — the source branch's purpose, the note's
 * source label, or the conversation's title — back: the fact); every
 * branch's answer or conclusion (front: its purpose, or the card's question;
 * back: the leaf line, or the conclusion); every glossary term (front: the
 * term; back: its explanation).
 */
export function treeFlashcards(tree: TreeExport): Flashcard[] {
  const asides = tree.branches.filter((branch) => branch.kind === "aside").flatMap((branch) => asideCard(tree, branch) ?? []);
  const facts = activeNotes(tree)
    .filter((note) => note.section === "fact" && note.text.trim())
    .map((note): Flashcard => {
      const source = tree.branches.find((branch) => branch.lineId === note.sourceLineId);
      return { front: source?.purpose || note.sourceLabel || titleOf(tree), back: note.text.trim(), source: "fact", lineId: note.sourceLineId, ...(note.sourceMessageId ? { messageId: note.sourceMessageId } : {}) };
    });
  const cards = new Map<string, Message>();
  for (const messages of Object.values(tree.messagesByLine)) for (const message of messages) if (message.kind === "branch_card" && message.meta.branchLineId) cards.set(message.meta.branchLineId, message);
  const answers = tree.branches.flatMap((branch): Flashcard[] => {
    if (branch.kind === "aside") return [];
    if (branch.leaf && (branch.leaf.kind === "answer" || branch.leaf.kind === "conclusion") && branch.leaf.line.trim()) {
      return [{ front: branch.purpose, back: branch.leaf.line.trim(), source: "answer", lineId: branch.lineId }];
    }
    const card = cards.get(branch.lineId);
    const conclusion = card?.meta.card?.conclusion || (branch.status === "merged" ? branch.conclusionLine : "");
    if (!conclusion.trim()) return [];
    return [{ front: card?.meta.card?.question || branch.purpose, back: conclusion.trim(), source: "answer", lineId: branch.lineId, ...(card ? { messageId: card.id } : {}) }];
  });
  const terms = tree.terms
    .filter((term) => term.term.trim() && term.explanation.trim())
    .map((term): Flashcard => ({ front: term.term.trim(), back: term.explanation.trim(), source: "term", lineId: term.sourceLineId, ...(term.sourceMessageId ? { messageId: term.sourceMessageId } : {}) }));
  return [...asides, ...facts, ...answers, ...terms];
}

export function flashcardCounts(cards: readonly Flashcard[]): Record<FlashcardSource, number> {
  const count = (source: FlashcardSource) => cards.filter((card) => card.source === source).length;
  return { aside: count("aside"), fact: count("fact"), answer: count("answer"), term: count("term") };
}

/** 講義 (.md): each card's front and back, with its source. */
export function flashcardsMarkdown(cards: readonly Flashcard[], labels: TreeExportLabels, title: string): string {
  const body = cards.flatMap((card, index) => [
    heading(2, `${index + 1}. ${singleLine(card.front)}`),
    "",
    `**${inlineEscape(labels.front)}**`,
    "",
    quoteBody(card.front),
    "",
    `**${inlineEscape(labels.back)}**`,
    "",
    quoteBody(card.back),
    "",
    `_${inlineEscape(labels.source(card.source))}_`,
    "",
  ]);
  return `${[heading(1, labels.cardsTitle(title)), "", ...body].join("\n").trimEnd()}\n`;
}

/** One Anki field: tabs become spaces, line breaks `<br>`. */
function tsvField(text: string): string {
  return text.trim().replace(/\t/g, " ").replace(/\r\n?|\n/g, "<br>");
}

/** Anki (.tsv): front and back, tab separated, one card per line, no header row. */
export function flashcardsTsv(cards: readonly Flashcard[]): string {
  return cards.map((card) => `${tsvField(card.front)}\t${tsvField(card.back)}\n`).join("");
}

// The dialog's numbers -----------------------------------------------------------

export interface ExportScope {
  /** User and AI chat messages of every line. */
  messages: number;
  branches: number;
  /** Active notes. */
  notes: number;
  comparisons: number;
}

export function exportScope(tree: TreeExport): ExportScope {
  const messages = Object.values(tree.messagesByLine).reduce((sum, list) => sum + chatMessages(list).length, 0);
  return { messages, branches: tree.branches.length, notes: activeNotes(tree).length, comparisons: tree.comparisons.length };
}

/** How many lines reached the per-line cap (the truncation banner's count). */
export function truncatedLines(tree: TreeExport): number {
  return Object.values(tree.messagesByLine).filter((list) => list.length >= EXPORT_MAX_MESSAGES_PER_LINE).length;
}
