-- Jobs: one-shot background work the host runs.

-- name: InsertJob :one
INSERT INTO tangent_job (id, tenant_id, kind, feature, line_id, input)
VALUES (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(kind), sqlc.arg(feature), sqlc.narg(line_id), sqlc.arg(input))
RETURNING *;

-- name: GetJob :one
SELECT * FROM tangent_job WHERE id = $1;

-- name: GetJobForUpdate :one
SELECT * FROM tangent_job WHERE id = $1 FOR UPDATE;

-- name: FinishJob :one
-- Ends a pending job; matches nothing once it is no longer pending.
UPDATE tangent_job SET status = sqlc.arg(status), error = sqlc.arg(error), finished_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND status = 'pending'
RETURNING *;

-- name: SupersedePendingJobs :many
-- Marks the pending jobs of a kind on a set of lines superseded.
UPDATE tangent_job SET status = 'superseded', finished_at = clock_timestamp()
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND kind = sqlc.arg(kind) AND status = 'pending'
RETURNING id;

-- name: LatestPendingJob :one
SELECT * FROM tangent_job
WHERE line_id = sqlc.arg(line_id) AND kind = sqlc.arg(kind) AND status = 'pending'
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: FailStaleJobs :many
-- Fails the pending jobs of a kind created before the cutoff (one batch;
-- rows another transaction holds are left for the next sweep).
UPDATE tangent_job SET status = 'failed', error = sqlc.arg(error), finished_at = clock_timestamp()
WHERE id IN (
    SELECT j.id FROM tangent_job j
    WHERE j.kind = sqlc.arg(kind) AND j.status = 'pending' AND j.created_at < sqlc.arg(cutoff)
    ORDER BY j.created_at
    LIMIT sqlc.arg(row_limit)
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: ListPendingJobIDsForLines :many
-- Pending jobs of a set of lines (they go with the lines when those are deleted).
SELECT id FROM tangent_job
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND status = 'pending'
ORDER BY id;

-- name: LatestJobOfKind :one
-- The newest job of a kind on a line, whatever its status.
SELECT * FROM tangent_job
WHERE line_id = sqlc.arg(line_id) AND kind = sqlc.arg(kind)
ORDER BY created_at DESC, id DESC
LIMIT 1;
