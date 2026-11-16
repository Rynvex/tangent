-- Memos (B13): never read by a prompt or a job.

-- name: InsertMemo :one
INSERT INTO tangent_memo (tenant_id, root_line_id, line_id, source_label, text, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.narg(line_id), sqlc.arg(source_label), sqlc.arg(text), sqlc.arg(created_by))
RETURNING *;

-- name: GetMemo :one
SELECT * FROM tangent_memo WHERE id = $1;

-- name: CountMemos :one
SELECT count(*)::int FROM tangent_memo WHERE root_line_id = $1;

-- name: ListMemos :many
-- A conversation's memos, oldest first; only one node's when line_id is given.
SELECT * FROM tangent_memo
WHERE root_line_id = sqlc.arg(root_line_id)
  AND (sqlc.narg(line_id)::uuid IS NULL OR line_id = sqlc.narg(line_id)::uuid)
ORDER BY created_at, id
LIMIT sqlc.arg(row_limit);

-- name: UpdateMemoText :one
UPDATE tangent_memo SET text = sqlc.arg(text), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteMemo :exec
DELETE FROM tangent_memo WHERE id = $1;

-- name: RehomeMemos :execrows
-- Detach (spinoff): the memos written on the lines that leave follow them
-- into the new conversation, as seeds and leaves do.
UPDATE tangent_memo SET root_line_id = sqlc.arg(root_line_id)
WHERE root_line_id = sqlc.arg(old_root_line_id) AND line_id = ANY(sqlc.arg(line_ids)::uuid[]);
