/**
 * Wire shapes and normalizers for B25 import batch routes (`GET /imports` and
 * `DELETE /imports/{bid}`).
 */
import { count, list, obj, str, strings } from "./wire";

/** `domain.ImportBatchLabelMaxRunes`. */
export const IMPORT_BATCH_LABEL_MAX_RUNES = 120;

export const IMPORT_KEPT_REASONS = ["attached", "busy", "changed"] as const;
export type ImportKeptReason = (typeof IMPORT_KEPT_REASONS)[number];

/** One import batch entry from `GET /imports`. */
export interface ImportBatch {
  id: string;
  label: string;
  createdAt: string;
  lineCount: number;
  standaloneCount: number;
}

/** `GET /imports` query. */
export interface ListImportBatchesQuery {
  limit?: number;
  cursor?: string;
}

/** `GET /imports` body: cursor paging, newest first. */
export interface ImportBatchPage {
  imports: ImportBatch[];
  nextCursor: string;
}

/** One line of an undone batch that was kept and why. */
export interface KeptImportLine {
  lineId: string;
  reason: ImportKeptReason | string;
}

/** `DELETE /imports/{bid}` body: main lines deleted vs lines kept in import order. */
export interface ImportBatchDeletion {
  deleted: string[];
  kept: KeptImportLine[];
}

/** `DELETE /imports/{bid}` query. */
export interface DeleteImportBatchQuery {
  force?: boolean;
}

export function normalizeImportBatch(raw: unknown): ImportBatch {
  const item = obj(raw);
  return {
    id: str(item.id),
    label: str(item.label),
    createdAt: str(item.createdAt),
    lineCount: count(item.lineCount),
    standaloneCount: count(item.standaloneCount),
  };
}

export function normalizeImportBatchPage(raw: unknown): ImportBatchPage {
  const page = obj(raw);
  return {
    imports: list(page.imports, normalizeImportBatch),
    nextCursor: str(page.nextCursor),
  };
}

export function normalizeImportBatchDeletion(raw: unknown): ImportBatchDeletion {
  const out = obj(raw);
  return {
    deleted: strings(out.deleted),
    kept: list(out.kept, (item) => {
      const entry = obj(item);
      return { lineId: str(entry.lineId), reason: str(entry.reason) };
    }),
  };
}
