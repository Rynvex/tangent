-- Comparisons of sibling branches (the diverge feature, B10 part B).

-- name: InsertComparison :one
INSERT INTO tangent_comparison (tenant_id, parent_line_id, line_ids, criteria, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(parent_line_id), sqlc.arg(line_ids)::uuid[], sqlc.arg(criteria), sqlc.arg(created_by))
RETURNING *;

-- name: GetComparison :one
SELECT * FROM tangent_comparison WHERE id = $1;

-- name: GetComparisonForUpdate :one
SELECT * FROM tangent_comparison WHERE id = $1 FOR UPDATE;

-- name: ListComparisonsOfLine :many
-- The comparisons of branches of a line, newest first.
SELECT * FROM tangent_comparison WHERE parent_line_id = sqlc.arg(parent_line_id)
ORDER BY created_at DESC, id
LIMIT sqlc.arg(row_limit);

-- name: SetComparisonJob :one
UPDATE tangent_comparison SET source_job_id = sqlc.arg(job_id), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: FinishComparison :one
-- Writes a converge job's outcome on the drafting comparison it was started for.
UPDATE tangent_comparison SET matrix = sqlc.narg(matrix), status = sqlc.arg(status), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND source_job_id = sqlc.arg(job_id) AND status = 'drafting'
RETURNING *;

-- name: FailComparisonOfJob :one
-- The drafting comparison whose converge job timed out.
UPDATE tangent_comparison SET status = 'failed', updated_at = clock_timestamp()
WHERE source_job_id = $1 AND status = 'drafting'
RETURNING *;

-- name: DecideComparison :one
UPDATE tangent_comparison SET status = 'decided', decided_line_id = sqlc.arg(decided_line_id), decided_by = sqlc.arg(decided_by),
    decided_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: ListTreeComparisons :many
-- The comparisons of branches of any of the lines (an export, B14),
-- oldest first.
SELECT * FROM tangent_comparison WHERE tenant_id = sqlc.arg(tenant_id) AND parent_line_id = ANY(sqlc.arg(line_ids)::uuid[])
ORDER BY created_at, id
LIMIT sqlc.arg(row_limit);
