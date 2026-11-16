/**
 * The mock's B25 import batch routes (`GET /imports`, `DELETE /imports/{bid}`):
 * lists the tenant's client-named batches newest-first with counts, and undoes a
 * batch by deleting standalone trees that have not changed since import (unless
 * `force: true`), removing the batch row when nothing is kept.
 */
import type { DeleteImportBatchQuery, ImportBatch, ImportBatchDeletion, ImportBatchPage, KeptImportLine, ListImportBatchesQuery } from "../b25-routes";
import { TangentError } from "../errors";
import type { MockContext } from "./mock-context";
import { deleteTree } from "./mock-delete";
import { invalid } from "./mock-import";
import { rootOf, type MockState } from "./mock-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_BATCH_PAGE = 50;
const MAX_BATCH_PAGE = 200;

export interface MockB25 {
  listImportBatches(query: ListImportBatchesQuery): ImportBatchPage;
  deleteImportBatch(batchId: string, query: DeleteImportBatchQuery): ImportBatchDeletion;
}

/** Matches `store/queries/import_batches.sql`'s `ImportedTreeChanged`. */
function isImportedTreeChanged(state: MockState, rootId: string, treeIds: ReadonlySet<string>): boolean {
  const root = state.lines.find((line) => line.id === rootId);
  const baseline = state.importBaselines[rootId];
  if (baseline && root && root.lastActivityAt !== baseline.activityAt) return true;
  const baselineSeq = baseline?.seq ?? 0;
  if (state.messages.some((m) => treeIds.has(m.lineId) && (m.seq > baselineSeq || Boolean(m.meta.editedAt)))) return true;
  if (state.branches.some((branch) => branch.rootLineId === rootId && branch.origin !== "import")) return true;
  if ((state.notesByRoot[rootId]?.length ?? 0) > 0) return true;
  if (state.memos.some((memo) => memo.rootLineId === rootId)) return true;
  if (state.terms.some((term) => term.rootLineId === rootId)) return true;
  if (state.seeds.some((seed) => seed.rootLineId === rootId)) return true;
  return false;
}

export function createMockB25(ctx: MockContext): MockB25 {
  function listImportBatches(query: ListImportBatchesQuery): ImportBatchPage {
    let limit = DEFAULT_BATCH_PAGE;
    if (query.limit !== undefined) {
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_BATCH_PAGE) {
        throw invalid("limit", `limit must be between 1 and ${MAX_BATCH_PAGE}`);
      }
      limit = query.limit;
    }
    let offset = 0;
    if (query.cursor !== undefined && query.cursor !== "") {
      if (!/^\d+$/.test(query.cursor)) throw invalid("cursor", "invalid cursor");
      offset = Number(query.cursor);
    }
    const state = ctx.state();
    const sorted = [...state.importBatches].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const page = sorted.slice(offset, offset + limit).map((batch): ImportBatch => {
      const lines = state.lines.filter((line) => line.importBatchId === batch.id);
      const standaloneCount = lines.filter((line) => line.conversationBranch === null).length;
      return { id: batch.id, label: batch.label, createdAt: batch.createdAt, lineCount: lines.length, standaloneCount };
    });
    const nextCursor = offset + limit < sorted.length ? String(offset + limit) : "";
    return { imports: page, nextCursor };
  }

  function deleteImportBatch(batchId: string, query: DeleteImportBatchQuery): ImportBatchDeletion {
    const trimmed = batchId.trim().toLowerCase();
    if (!UUID_RE.test(trimmed) || trimmed === NIL_UUID || !ctx.state().importBatches.some((batch) => batch.id === trimmed)) {
      throw new TangentError(404, "import batch not found", "import_batch_not_found");
    }
    const initial = ctx.state();
    const lines = initial.lines
      .filter((line) => line.importBatchId === trimmed)
      .sort((a, b) => (initial.importBaselines[a.id]?.seq ?? 0) - (initial.importBaselines[b.id]?.seq ?? 0) || a.id.localeCompare(b.id));
    const deleted: string[] = [];
    const kept: KeptImportLine[] = [];
    for (const entry of lines) {
      const current = ctx.state();
      const line = current.lines.find((item) => item.id === entry.id);
      if (!line || line.importBatchId !== trimmed) continue;
      if (line.conversationBranch !== null) {
        kept.push({ lineId: line.id, reason: "attached" });
        continue;
      }
      const treeIds = new Set([line.id, ...current.lines.filter((item) => item.id !== line.id && rootOf(item) === line.id).map((item) => item.id)]);
      const busy = current.lines.some((item) => treeIds.has(item.id) && item.status === "thinking") || current.messages.some((m) => treeIds.has(m.lineId) && m.status === "pending");
      if (busy) {
        kept.push({ lineId: line.id, reason: "busy" });
        continue;
      }
      if (!query.force && isImportedTreeChanged(current, line.id, treeIds)) {
        kept.push({ lineId: line.id, reason: "changed" });
        continue;
      }
      const { state: next, result } = deleteTree(current, line.id);
      ctx.commit(next);
      ctx.bus.publish("line.deleted", { lineId: line.id, rootLineId: line.id }, result);
      deleted.push(line.id);
    }
    if (kept.length === 0) {
      const current = ctx.state();
      const remaining = current.lines.some((line) => line.importBatchId === trimmed);
      if (!remaining) {
        ctx.commit({ ...current, importBatches: current.importBatches.filter((batch) => batch.id !== trimmed) });
      }
    }
    return { deleted, kept };
  }

  return { listImportBatches, deleteImportBatch };
}
