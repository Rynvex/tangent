-- Chapters: topic cuts from rolling summaries and operator milestones.

-- name: InsertChapterCut :one
INSERT INTO tangent_chapter_cut (tenant_id, root_line_id, line_id, message_id, kind, title, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(line_id), sqlc.arg(message_id), sqlc.arg(kind), sqlc.arg(title), sqlc.arg(created_by))
ON CONFLICT (message_id, kind) DO NOTHING
RETURNING *;

-- name: ListChapterCuts :many
SELECT * FROM tangent_chapter_cut WHERE root_line_id = $1
ORDER BY created_at DESC, id LIMIT 1000;

-- name: CountChapterCutsByKind :one
SELECT count(*)::int FROM tangent_chapter_cut WHERE root_line_id = $1 AND kind = $2;

-- name: DeleteChapterMilestone :execrows
DELETE FROM tangent_chapter_cut WHERE id = $1 AND root_line_id = $2 AND kind = 'milestone';

-- name: ListChapterCutsOnMessages :many
-- The cuts of a conversation that sit on one of the messages (B18).
SELECT * FROM tangent_chapter_cut
WHERE root_line_id = sqlc.arg(root_line_id) AND message_id = ANY(sqlc.arg(message_ids)::uuid[]);

-- name: MoveChapterCut :exec
UPDATE tangent_chapter_cut SET message_id = sqlc.arg(message_id), line_id = sqlc.arg(line_id) WHERE id = sqlc.arg(id);
