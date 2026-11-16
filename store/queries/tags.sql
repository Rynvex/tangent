-- Argument tags of messages (the ibis feature, B10 part A).

-- name: GetMessageTag :one
SELECT * FROM tangent_message_tag WHERE message_id = $1;

-- name: ListMessageTags :many
SELECT * FROM tangent_message_tag WHERE message_id = ANY(sqlc.arg(message_ids)::uuid[]);

-- name: PutTag :one
-- The operator's tag replaces whatever the message had: confirmed (source
-- user) or, put back for review (B15), a draft (source ai).
INSERT INTO tangent_message_tag (message_id, tenant_id, kind, source, status, updated_by)
VALUES (sqlc.arg(message_id), sqlc.arg(tenant_id), sqlc.arg(kind), sqlc.arg(source), sqlc.arg(status), sqlc.arg(updated_by))
ON CONFLICT (message_id) DO UPDATE
SET kind = EXCLUDED.kind, source = EXCLUDED.source, status = EXCLUDED.status, source_job_id = NULL,
    updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
RETURNING *;

-- name: DeleteMessageTag :one
DELETE FROM tangent_message_tag WHERE message_id = $1 RETURNING *;

-- name: InsertAITag :one
-- A model's tag only where the message has none: nothing a model writes
-- replaces a tag (the operator's above all).
INSERT INTO tangent_message_tag (message_id, tenant_id, kind, source, status, source_job_id)
VALUES (sqlc.arg(message_id), sqlc.arg(tenant_id), sqlc.arg(kind), 'ai', sqlc.arg(status), sqlc.arg(source_job_id))
ON CONFLICT (message_id) DO NOTHING
RETURNING *;

-- name: ListUntaggedChatMessages :many
-- Of a line's newest scan_limit finished operator and assistant messages
-- between two seqs (after one, up to the other), the ones without a tag,
-- newest first.
SELECT m.* FROM (
    SELECT * FROM tangent_message
    WHERE line_id = sqlc.arg(line_id) AND seq > sqlc.arg(after_seq)::bigint AND seq <= sqlc.arg(upto_seq)::bigint
      AND status = 'done' AND kind = 'chat' AND role IN ('user','assistant')
    ORDER BY seq DESC
    LIMIT sqlc.arg(scan_limit)
) m
WHERE NOT EXISTS (SELECT 1 FROM tangent_message_tag t WHERE t.message_id = m.id)
ORDER BY m.seq DESC
LIMIT sqlc.arg(row_limit);

-- name: ListTreeTagDrafts :many
-- The finished operator and assistant messages of a tree (its main line
-- and every branch line) whose tag is a draft (B15): the main line first,
-- then the branches in outline order, each line by seq. Lines of discarded
-- branches are left out; content is read up to content_runes characters
-- (the caller cuts it to a snippet).
SELECT m.id, m.line_id, m.seq, m.role, left(m.content, sqlc.arg(content_runes)::int) AS content,
       t.kind AS tag_kind, t.source AS tag_source, t.status AS tag_status, t.updated_at AS tag_updated_at
FROM tangent_message m
JOIN tangent_message_tag t ON t.message_id = m.id
LEFT JOIN tangent_branch b ON b.line_id = m.line_id
WHERE m.tenant_id = sqlc.arg(tenant_id)
  AND m.line_id IN (SELECT sqlc.arg(root_line_id)::uuid UNION ALL SELECT line_id FROM tangent_branch WHERE root_line_id = sqlc.arg(root_line_id))
  AND t.status = 'draft'
  AND (b.status IS NULL OR b.status <> 'discarded')
  AND m.status = 'done' AND m.kind = 'chat' AND m.role IN ('user','assistant')
ORDER BY b.created_at NULLS FIRST, m.line_id, m.seq
LIMIT sqlc.arg(row_limit);

-- name: LatestDoneJobInput :one
-- The input of a line's newest finished job of a kind.
SELECT input FROM tangent_job
WHERE line_id = sqlc.arg(line_id) AND kind = sqlc.arg(kind) AND status = 'done'
ORDER BY created_at DESC
LIMIT 1;
