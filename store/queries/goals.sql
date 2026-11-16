-- Conversation goals (B9).

-- name: GetGoal :one
SELECT * FROM tangent_goal WHERE root_line_id = $1;

-- name: UpsertGoal :one
INSERT INTO tangent_goal (root_line_id, tenant_id, text, source, updated_by)
VALUES (sqlc.arg(root_line_id), sqlc.arg(tenant_id), sqlc.arg(text), sqlc.arg(source), sqlc.arg(updated_by))
ON CONFLICT (root_line_id) DO UPDATE
SET text = EXCLUDED.text, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
RETURNING *;

-- name: DeleteGoal :one
DELETE FROM tangent_goal WHERE root_line_id = $1 RETURNING *;
