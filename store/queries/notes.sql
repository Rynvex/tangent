-- Notes: the one-page summary shared by a whole conversation.

-- name: ListNotes :many
SELECT * FROM tangent_note WHERE root_line_id = $1
ORDER BY created_at DESC, id LIMIT 1000;

-- name: ListActiveNotes :many
SELECT * FROM tangent_note WHERE root_line_id = $1 AND status = 'active'
ORDER BY created_at DESC, id LIMIT 200;

-- name: CountNotes :one
SELECT count(*)::int AS total, (count(*) FILTER (WHERE status = 'active'))::int AS active
FROM tangent_note WHERE root_line_id = $1;

-- name: GetNoteForUpdate :one
SELECT * FROM tangent_note WHERE id = sqlc.arg(id) AND root_line_id = sqlc.arg(root_line_id) FOR UPDATE;

-- name: InsertNote :one
INSERT INTO tangent_note (tenant_id, root_line_id, section, text, source_line_id, source_message_id, source_card_message_id, source_label, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(section), sqlc.arg(text),
        sqlc.narg(source_line_id), sqlc.narg(source_message_id), sqlc.narg(source_card_message_id), sqlc.arg(source_label), sqlc.arg(created_by))
RETURNING *;

-- name: UpdateNote :one
UPDATE tangent_note SET section = $2, text = $3, status = $4, updated_at = now()
WHERE id = $1 RETURNING *;

-- name: SupersedeNote :one
UPDATE tangent_note SET status = 'superseded', superseded_by = sqlc.arg(superseded_by), updated_at = now()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: LineInTree :one
-- Whether a line is the root or a branch of the root's tree.
SELECT (l.id = sqlc.arg(root_id)::uuid OR EXISTS (
    SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id AND b.root_line_id = sqlc.arg(root_id)::uuid
))::boolean AS in_tree
FROM tangent_line l WHERE l.id = sqlc.arg(line_id)::uuid;

-- name: MessageLineInTree :one
-- The line a message sits on, and whether that line belongs to the root's tree.
SELECT m.line_id, (m.line_id = sqlc.arg(root_id)::uuid OR EXISTS (
    SELECT 1 FROM tangent_branch b WHERE b.line_id = m.line_id AND b.root_line_id = sqlc.arg(root_id)::uuid
))::boolean AS in_tree
FROM tangent_message m WHERE m.id = sqlc.arg(message_id)::uuid;
