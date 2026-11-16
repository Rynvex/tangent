/**
 * The messages between the import dialog's parser (import-parse.ts) and its
 * worker (import-worker.ts), in a module of their own so the worker's chunk
 * holds only the parsers and this (B18.1).
 */
import type { ImportParseResult } from "@tangent/client";

/** The worker's answer when the file needs the DOM. */
export const IMPORT_NEEDS_DOM = "tangent-import-needs-dom";

export interface ImportWorkerRequest {
  token: number;
  text: string;
  fileName: string;
  /** F14: the file's lastModified (ISO), for conversations without a date of their own. */
  fileModifiedAt?: string | null;
}

export type ImportWorkerReply =
  | { token: number; kind: "parsed"; result: ImportParseResult }
  | { token: number; kind: "needsDom" }
  | { token: number; kind: "failed"; message: string };
