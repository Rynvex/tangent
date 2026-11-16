-- Parked thoughts (B8).

-- name: InsertSeed :one
INSERT INTO tangent_seed (tenant_id, root_line_id, anchor_message_id, text, source_label, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.narg(anchor_message_id), sqlc.arg(text), sqlc.arg(source_label), sqlc.arg(created_by))
RETURNING *;

-- name: MessageLines :many
-- The line each of the messages is on now (gone ones are missing).
SELECT id, line_id FROM tangent_message WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: GetSeed :one
SELECT * FROM tangent_seed WHERE id = $1;

-- name: GetSeedForUpdate :one
SELECT * FROM tangent_seed WHERE id = $1 FOR UPDATE;

-- name: CountOpenSeeds :one
SELECT count(*)::int FROM tangent_seed WHERE root_line_id = $1 AND status = 'open';

-- name: ListSeeds :many
-- A conversation's seeds of the given statuses, newest first.
SELECT * FROM tangent_seed
WHERE root_line_id = sqlc.arg(root_line_id) AND status = ANY(sqlc.arg(statuses)::text[])
ORDER BY created_at DESC, id
LIMIT sqlc.arg(row_limit);

-- name: FinishSeed :one
-- Ends an open seed: expanded (with its branch), noted (with its note) or dropped.
UPDATE tangent_seed
SET status = sqlc.arg(status), expanded_line_id = sqlc.narg(expanded_line_id), note_id = sqlc.narg(note_id), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND status = 'open'
RETURNING *;
