/**
 * F14 S4: sending an assembly's imports (import-assembly-build.ts) one after
 * the other, in S2's order; with relations on, each main line is related to
 * the next one in that order (decision #7). A failed import does not stop
 * the others (the design's 「5 條主線建好 4 條」): it is reported, the ones
 * made stay, and it can be retried alone. Undoing an import (decision #8)
 * deletes the main lines it made, with the existing `DELETE /lines/{id}`.
 * No model is called. B21: every request waits out the server's rate limit
 * (rate-limit-retry.ts) and the undo deletes a few lines at a time, so a
 * batch of hundreds of conversations does not fail on `429 rate_limited`.
 */
import type { ImportConversationInput, ImportConversationResult } from "./b18-routes";
import { TangentError } from "./errors";
import type { DeleteLineResult } from "./api-types";
import type { CreateRelationInput, RelationWrite } from "./p2-routes";
import { settleBounded, withRateLimitRetry, type RateLimitRetryOptions } from "./rate-limit-retry";

/** B21: how many deletes an undo runs at once. */
export const UNDO_CONCURRENCY = 4;

export interface AssemblyClient {
  importConversation(input: ImportConversationInput): Promise<ImportConversationResult>;
  createRelation(lineId: string, input: CreateRelationInput): Promise<RelationWrite>;
  deleteLine(lineId: string): Promise<DeleteLineResult>;
}

export interface AssemblyRunOptions {
  /** Relate neighbouring main lines (the relations feature is on and the user can write). */
  relate: boolean;
  /** Which imports to send (all by default); a retry sends the failed one alone. */
  only?: readonly number[];
  /** The main lines already made by an earlier run, by import index (a retry relates the new one to them). */
  made?: ReadonlyArray<string | null>;
  /** After each import: how many of this run's imports are done, of how many. */
  onProgress?: (done: number, total: number) => void;
  /** B21: how a request waits out `429 rate_limited` (its `onWait` says the run is waiting; tests inject `sleep`). */
  retry?: RateLimitRetryOptions;
}

export interface AssemblyRun {
  /** Each import's main line id by index (null: failed, or not sent in this run and not made before). */
  lineIds: Array<string | null>;
  /** This run's results by index. */
  results: Array<ImportConversationResult | null>;
  failures: Array<{ index: number; error: unknown }>;
  relations: { made: number; failed: number };
}

/** The neighbouring pairs (k, k+1) both made, and only those touching `touched` when given (a retry). */
export function relationPairs(lineIds: ReadonlyArray<string | null>, touched?: ReadonlySet<number>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let k = 0; k + 1 < lineIds.length; k += 1) {
    const from = lineIds[k];
    const to = lineIds[k + 1];
    if (!from || !to) continue;
    if (touched && !touched.has(k) && !touched.has(k + 1)) continue;
    pairs.push([from, to]);
  }
  return pairs;
}

/** Sends the imports in order, then relates neighbours; failures are collected, never thrown. */
export async function runAssembly(client: AssemblyClient, imports: readonly ImportConversationInput[], options: AssemblyRunOptions): Promise<AssemblyRun> {
  const indexes = options.only ? [...options.only] : imports.map((_, index) => index);
  const lineIds: Array<string | null> = imports.map((_, index) => options.made?.[index] ?? null);
  const results: Array<ImportConversationResult | null> = imports.map(() => null);
  const failures: AssemblyRun["failures"] = [];
  let done = 0;
  for (const index of indexes) {
    try {
      const result = await withRateLimitRetry(() => client.importConversation(imports[index]!), options.retry);
      results[index] = result;
      lineIds[index] = result.line.id;
    } catch (error) {
      failures.push({ index, error });
    }
    done += 1;
    options.onProgress?.(done, indexes.length);
  }
  const touched = new Set(indexes.filter((index) => results[index] !== null));
  const relations = { made: 0, failed: 0 };
  if (options.relate) {
    for (const [from, to] of relationPairs(lineIds, options.only ? touched : undefined)) {
      try {
        await withRateLimitRetry(() => client.createRelation(from, { toLineId: to, relationKind: "related" }), options.retry);
        relations.made += 1;
      } catch {
        relations.failed += 1;
      }
    }
  }
  return { lineIds, results, failures, relations };
}

/** What undoing an import did: deleted (with their branches), kept (attached into another conversation since, B20) or failed. */
export interface UndoAssemblyResult {
  deleted: string[];
  /** Lines attached as branches of a conversation outside the import: they stay there. */
  kept: string[];
  failed: string[];
}

const codeOf = (reason: unknown) => (reason instanceof TangentError ? reason.code : "");

export interface UndoAssemblyOptions {
  /** Deletes at once (UNDO_CONCURRENCY by default). */
  concurrency?: number;
  /** How a delete waits out `429 rate_limited`. */
  retry?: RateLimitRetryOptions;
}

/**
 * Decision #8: deletes what an import made (each main line, with its branches), a few at a time (B21), each waiting out
 * the rate limit. A line attached as a branch
 * since (B20, `branch_not_main_line`) is tried again once the others have settled: gone then (`line_not_found`), it went
 * with the conversation of this import it was attached to; still a branch, it lives on in another conversation (kept).
 * A line already gone counts as deleted; any other refusal is failed.
 */
export async function undoAssembly(client: Pick<AssemblyClient, "deleteLine">, lineIds: readonly string[], options: UndoAssemblyOptions = {}): Promise<UndoAssemblyResult> {
  const remove = (lineId: string) => withRateLimitRetry(() => client.deleteLine(lineId), options.retry);
  const settled = await settleBounded(lineIds, options.concurrency ?? UNDO_CONCURRENCY, remove);
  const out: UndoAssemblyResult = { deleted: [], kept: [], failed: [] };
  const attached: string[] = [];
  settled.forEach((result, index) => {
    const lineId = lineIds[index]!;
    if (result.status === "fulfilled" || codeOf(result.reason) === "line_not_found") out.deleted.push(lineId);
    else if (codeOf(result.reason) === "branch_not_main_line") attached.push(lineId);
    else out.failed.push(lineId);
  });
  for (const lineId of attached) {
    try {
      await remove(lineId);
      out.deleted.push(lineId);
    } catch (error) {
      const code = codeOf(error);
      (code === "line_not_found" ? out.deleted : code === "branch_not_main_line" ? out.kept : out.failed).push(lineId);
    }
  }
  return out;
}
