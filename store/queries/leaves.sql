-- Branch leaves (B8).

-- name: GetLeaf :one
SELECT * FROM tangent_leaf WHERE line_id = $1;

-- name: UpsertLeaf :one
INSERT INTO tangent_leaf (line_id, tenant_id, root_line_id, kind, line, body, status, source_job_id, created_by)
VALUES (sqlc.arg(line_id), sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(kind), sqlc.arg(line), sqlc.arg(body),
        sqlc.arg(status), sqlc.narg(source_job_id), sqlc.arg(created_by))
ON CONFLICT (line_id) DO UPDATE
SET kind = EXCLUDED.kind, line = EXCLUDED.line, body = EXCLUDED.body, status = EXCLUDED.status,
    source_job_id = EXCLUDED.source_job_id, created_by = EXCLUDED.created_by, updated_at = clock_timestamp()
RETURNING *;

-- name: DeleteLeaf :one
DELETE FROM tangent_leaf WHERE line_id = $1 RETURNING *;
