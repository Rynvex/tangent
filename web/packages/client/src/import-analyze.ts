/**
 * B22: `POST /lines/import-analyze`, the import analysis (docs/API.md). The
 * rounds (or whole conversations) of an import are sent as units; the server
 * answers with a proposed tree: units of one topic threaded into one node
 * even when other topics came between them (A → B → A → C → A → B), and each
 * node's role. The model may propose it (`source: "model"`); the server's
 * deterministic analyzer always can (`"heuristic"`), and so can the mock's
 * `analyzeImportLocal` (import-analyze-local.ts), with no network at all.
 * Applying a plan to the F14 assembly is import-analyze-apply.ts. Pure.
 */
import type { AssemblyMode, NodeRole } from "./import-assembly";
import { list, obj, oneOf, str, strings } from "./wire";

/** `domain.ImportAnalyzeMaxUnits`. */
export const IMPORT_ANALYZE_MAX_UNITS = 200;
/** `domain.ImportAnalyzeTextRunes`: the excerpt of a unit's question and answer the deterministic analyzer (and a repair) reads. */
export const IMPORT_ANALYZE_TEXT_RUNES = 300;
/** `domain.ImportAnalyzeQuestionRunes` (B26): how much of a unit's question the server takes (its model reads all of it). */
export const IMPORT_ANALYZE_QUESTION_RUNES = 600;
/** `domain.ImportAnalyzeAnswerRunes` (B26): how much of a unit's answer the server takes. */
export const IMPORT_ANALYZE_ANSWER_RUNES = 2000;
/** `domain.ImportAnalyzeKeyRunes`. */
export const IMPORT_ANALYZE_KEY_RUNES = 200;
/** `domain.ImportAnalyzeTitleRunes`: a unit's and the input's title. */
export const IMPORT_ANALYZE_TITLE_RUNES = 200;
/** `domain.ImportAnalyzeNodeTitleRunes`. */
export const IMPORT_ANALYZE_NODE_TITLE_RUNES = 60;
/** `domain.ImportAnalyzeMaxUnitMessages`. */
export const IMPORT_ANALYZE_MAX_UNIT_MESSAGES = 100_000;

/** One Q&A round (or a whole conversation) to be threaded and organized into a tree. */
export interface ImportAnalyzeUnit {
  key: string;
  title?: string;
  question: string;
  answer: string;
  messageCount: number;
  /** When the unit began (RFC 3339), if its source says; the server's model sees the gaps between units. */
  startAt?: string;
}

export interface ImportAnalyzeInput {
  title?: string;
  units: ImportAnalyzeUnit[];
}

/** One topic node of the proposed tree. */
export interface ImportAnalyzeNode {
  /** The node's earliest unit. */
  key: string;
  /** Every unit threaded into it, in input order (u1, u3, u5 for A → B → A → C → A). */
  unitKeys: string[];
  title: string;
  role: NodeRole;
  /** A branch's chapter node (its key). */
  attachToKey?: string;
  /** The chapter's unit right before the branch forked. */
  attachAfterUnitKey?: string;
  /** A merged branch's drafted conclusion. */
  conclusion?: string;
  /** Why these units were threaded or got this role. */
  reason?: string;
}

export type ImportAnalyzeSource = "model" | "heuristic";

export interface ImportAnalyzePlan {
  mode: AssemblyMode;
  source: ImportAnalyzeSource;
  summary: string;
  /** Every input unit is in exactly one node. */
  nodes: ImportAnalyzeNode[];
}

const ROLES: readonly NodeRole[] = ["chapter", "merged_branch", "open_branch", "standalone"];
const MODES: readonly AssemblyMode[] = ["tree", "timeline", "batch"];

/** The optional text keys of a node, kept only when the server sent them (`omitempty`). */
const OPTIONAL_NODE_KEYS = ["attachToKey", "attachAfterUnitKey", "conclusion", "reason"] as const;

function normalizeNode(raw: unknown): ImportAnalyzeNode {
  const o = obj(raw);
  const optional = Object.fromEntries(OPTIONAL_NODE_KEYS.flatMap((key) => (typeof o[key] === "string" && o[key] !== "" ? [[key, o[key] as string]] : [])));
  return { key: str(o.key), unitKeys: strings(o.unitKeys), title: str(o.title), role: oneOf(o.role, ROLES, "chapter"), ...optional };
}

/** `POST /lines/import-analyze`'s answer, from untrusted JSON. */
export function normalizeImportAnalyzePlan(raw: unknown): ImportAnalyzePlan {
  const o = obj(raw);
  return {
    mode: oneOf(o.mode, MODES, "tree"),
    source: oneOf(o.source, ["model", "heuristic"] as const, "heuristic"),
    summary: str(o.summary),
    nodes: list(o.nodes, normalizeNode),
  };
}

/** Whether a role hangs on a chapter. */
export const isBranchRole = (role: NodeRole): boolean => role === "merged_branch" || role === "open_branch";
