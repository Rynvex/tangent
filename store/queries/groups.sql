-- Groups of branches and combined branches (B9 part C).

-- name: InsertGroup :one
INSERT INTO tangent_group (tenant_id, root_line_id, title, settled, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(title), sqlc.arg(settled), sqlc.arg(created_by))
RETURNING *;

-- name: InsertGroupMember :exec
INSERT INTO tangent_group_member (group_id, line_id) VALUES ($1, $2);

-- name: GetGroup :one
SELECT * FROM tangent_group WHERE id = $1;

-- name: GetGroupForUpdate :one
SELECT * FROM tangent_group WHERE id = $1 FOR UPDATE;

-- name: ListGroupsOfRoot :many
-- A tree's groups of the statuses, newest first.
SELECT * FROM tangent_group
WHERE root_line_id = sqlc.arg(root_line_id) AND status = ANY(sqlc.arg(statuses)::text[])
ORDER BY created_at DESC, id
LIMIT sqlc.arg(row_limit);

-- name: ListMembersOfGroups :many
-- The members of the groups, in the order their branches were opened.
SELECT m.group_id, m.line_id
FROM tangent_group_member m
JOIN tangent_branch b ON b.line_id = m.line_id
WHERE m.group_id = ANY(sqlc.arg(group_ids)::uuid[])
ORDER BY b.created_at, m.line_id;

-- name: CountActiveGroups :one
SELECT count(*)::int FROM tangent_group WHERE root_line_id = $1 AND status = 'active';

-- name: ActiveGroupLines :many
-- Which of the lines already belong to an active group.
SELECT m.line_id
FROM tangent_group_member m
JOIN tangent_group g ON g.id = m.group_id
WHERE g.status = 'active' AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: RenameGroup :one
UPDATE tangent_group SET title = sqlc.arg(title), updated_at = clock_timestamp() WHERE id = sqlc.arg(id) RETURNING *;

-- name: DissolveGroup :one
UPDATE tangent_group SET status = 'dissolved', updated_at = clock_timestamp() WHERE id = $1 RETURNING *;

-- name: SetGroupSummaryJob :one
UPDATE tangent_group SET source_job_id = sqlc.arg(job_id), summary_status = 'drafting', updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: FinishGroupSummary :one
-- Writes a summary job's outcome; matches nothing once another job took over.
UPDATE tangent_group SET summary = sqlc.arg(summary), summary_status = sqlc.arg(summary_status), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND source_job_id = sqlc.arg(job_id)
RETURNING *;

-- name: DissolveGroupsOfLines :many
-- Dissolves the active groups any of the lines belongs to (a detach takes
-- them to another tree).
UPDATE tangent_group g SET status = 'dissolved', updated_at = clock_timestamp()
WHERE g.status = 'active' AND EXISTS (
    SELECT 1 FROM tangent_group_member m WHERE m.group_id = g.id AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[]))
RETURNING *;

-- name: SetMergedInto :exec
UPDATE tangent_branch SET merged_into_line_id = sqlc.arg(merged_into), updated_at = now()
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: FailGroupSummaryOfJob :one
-- An active group whose drafting summary's job timed out.
UPDATE tangent_group SET summary_status = 'failed', updated_at = clock_timestamp()
WHERE source_job_id = $1 AND summary_status = 'drafting' AND status = 'active'
RETURNING *;

-- name: ListOpenChildBranches :many
-- The open branches hanging directly on any of the lines, in id order.
SELECT line_id FROM tangent_branch
WHERE parent_line_id = ANY(sqlc.arg(parent_ids)::uuid[]) AND status = 'open'
ORDER BY line_id;

-- name: ListActiveGroupsOfLines :many
-- The active groups any of the lines belongs to (B23: a deleted branch
-- leaves its groups).
SELECT g.* FROM tangent_group g
WHERE g.status = 'active' AND EXISTS (
    SELECT 1 FROM tangent_group_member m WHERE m.group_id = g.id AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[]))
ORDER BY g.created_at, g.id;

-- name: DeleteGroupMembersOfLines :exec
DELETE FROM tangent_group_member WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);
