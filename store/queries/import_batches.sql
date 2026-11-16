-- Import batches (B25): the imports of one client action, so they can be
-- listed and undone later.

-- name: UpsertImportBatch :one
-- Creates the batch or, when it exists for the same tenant, keeps it as it
-- is (label and creator of the first import). The row stays locked until
-- the import commits, so undoing the batch waits for it. No row: the id is
-- another tenant's batch.
INSERT INTO tangent_import_batch (id, tenant_id, label, created_by)
VALUES (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(label), sqlc.arg(created_by))
ON CONFLICT (id) DO UPDATE SET label = tangent_import_batch.label
WHERE tangent_import_batch.tenant_id = EXCLUDED.tenant_id
RETURNING id;

-- name: MarkImportedLine :exec
-- Puts an imported main line in its batch and records the tree as the
-- import left it: its newest message seq and the main line's activity time.
UPDATE tangent_line l
SET import_batch_id = sqlc.arg(batch_id),
    import_seq = (SELECT coalesce(max(m.seq), 0) FROM tangent_message m
                  WHERE m.line_id IN (SELECT l.id UNION ALL SELECT b.line_id FROM tangent_branch b WHERE b.root_line_id = l.id)),
    import_activity_at = l.last_activity_at
WHERE l.id = sqlc.arg(id);

-- name: GetImportBatch :one
SELECT * FROM tangent_import_batch WHERE id = sqlc.arg(id) AND tenant_id = sqlc.arg(tenant_id);

-- name: ListImportBatches :many
-- One keyset page of a tenant's batches, newest first, with how many of
-- their lines exist and how many of those are still main lines.
SELECT b.id, b.label, b.created_at,
       (SELECT count(*) FROM tangent_line l WHERE l.tenant_id = b.tenant_id AND l.import_batch_id = b.id)::int AS line_count,
       (SELECT count(*) FROM tangent_line l WHERE l.tenant_id = b.tenant_id AND l.import_batch_id = b.id
          AND NOT EXISTS (SELECT 1 FROM tangent_branch br WHERE br.line_id = l.id))::int AS standalone_count
FROM tangent_import_batch b
WHERE b.tenant_id = sqlc.arg(tenant_id)
  AND (sqlc.narg(after_at)::timestamptz IS NULL
       OR (b.created_at, b.id) < (sqlc.narg(after_at)::timestamptz, sqlc.narg(after_id)::uuid))
ORDER BY b.created_at DESC, b.id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListImportBatchLines :many
-- The lines of a batch in import order, and whether each is a branch now
-- (attached to another conversation).
SELECT l.id, EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)::boolean AS attached
FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id) AND l.import_batch_id = sqlc.arg(batch_id)
ORDER BY l.import_seq, l.id;

-- name: ImportedTreeChanged :one
-- Whether a locked imported main line's tree was used since the import: its
-- activity time moved, a message was written after it (seq is global) or a
-- conclusion card edited, a branch that the import did not write exists, or
-- the tree has notes, memos, terms or parked thoughts (an import
-- writes none). Also returns the line's batch.
SELECT l.import_batch_id,
       (l.last_activity_at IS DISTINCT FROM l.import_activity_at
        OR EXISTS (SELECT 1 FROM tangent_message m
                   WHERE m.line_id IN (SELECT l.id UNION ALL SELECT b.line_id FROM tangent_branch b WHERE b.root_line_id = l.id)
                     AND (m.seq > coalesce(l.import_seq, 0) OR m.meta ->> 'editedAt' IS NOT NULL))
        OR EXISTS (SELECT 1 FROM tangent_branch b WHERE b.root_line_id = l.id AND b.origin <> 'import')
        OR EXISTS (SELECT 1 FROM tangent_note n WHERE n.root_line_id = l.id)
        OR EXISTS (SELECT 1 FROM tangent_memo mm WHERE mm.root_line_id = l.id)
        OR EXISTS (SELECT 1 FROM tangent_term t WHERE t.root_line_id = l.id)
        OR EXISTS (SELECT 1 FROM tangent_seed s WHERE s.root_line_id = l.id))::boolean AS changed
FROM tangent_line l
WHERE l.id = sqlc.arg(id);

-- name: LockImportBatch :one
SELECT id FROM tangent_import_batch WHERE id = sqlc.arg(id) AND tenant_id = sqlc.arg(tenant_id) FOR UPDATE;

-- name: CountImportBatchLines :one
SELECT count(*)::int FROM tangent_line WHERE tenant_id = sqlc.arg(tenant_id) AND import_batch_id = sqlc.arg(batch_id);

-- name: DeleteImportBatch :exec
DELETE FROM tangent_import_batch WHERE id = sqlc.arg(id) AND tenant_id = sqlc.arg(tenant_id);
