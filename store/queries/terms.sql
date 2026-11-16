-- The glossary (B24): terms of a conversation. Only the terms (not the
-- explanations) reach a prompt.

-- name: InsertTerm :one
INSERT INTO tangent_term (tenant_id, root_line_id, term, term_key, explanation, source_line_id, source_message_id, source_label, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(term), sqlc.arg(term_key), sqlc.arg(explanation),
        sqlc.narg(source_line_id), sqlc.narg(source_message_id), sqlc.arg(source_label), sqlc.arg(created_by))
RETURNING *;

-- name: GetTerm :one
SELECT * FROM tangent_term WHERE id = $1;

-- name: GetTermByKey :one
SELECT * FROM tangent_term WHERE root_line_id = sqlc.arg(root_line_id) AND term_key = sqlc.arg(term_key);

-- name: CountTerms :one
SELECT count(*)::int FROM tangent_term WHERE root_line_id = $1;

-- name: ListTerms :many
-- A conversation's glossary in key order.
SELECT * FROM tangent_term
WHERE root_line_id = sqlc.arg(root_line_id)
ORDER BY term_key, id
LIMIT sqlc.arg(row_limit);

-- name: ListRecentTermNames :many
-- The terms a prompt may carry, most recently updated first.
SELECT term FROM tangent_term
WHERE root_line_id = sqlc.arg(root_line_id)
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(row_limit);

-- name: ReplaceTermSource :one
-- Saving a term again with replace: the explanation and the source change,
-- the term as written stays.
UPDATE tangent_term SET explanation = sqlc.arg(explanation), source_line_id = sqlc.narg(source_line_id),
    source_message_id = sqlc.narg(source_message_id), source_label = sqlc.arg(source_label), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: UpdateTermText :one
UPDATE tangent_term SET term = sqlc.arg(term), term_key = sqlc.arg(term_key), explanation = sqlc.arg(explanation), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteTerm :exec
DELETE FROM tangent_term WHERE id = $1;

-- name: SearchTerms :many
-- The tenant's terms whose key contains q (those that start with it
-- first), outside archived conversations, after a keyset position.
SELECT t.*, l.title AS root_title, (NOT starts_with(t.term_key, sqlc.arg(q)::text))::int AS rank
FROM tangent_term t
JOIN tangent_line l ON l.id = t.root_line_id
WHERE t.tenant_id = sqlc.arg(tenant_id) AND l.archived_at IS NULL
  AND strpos(t.term_key, sqlc.arg(q)::text) > 0
  AND (sqlc.narg(after_id)::uuid IS NULL
       OR ((NOT starts_with(t.term_key, sqlc.arg(q)::text))::int, t.term_key, t.id)
          > (sqlc.arg(after_rank)::int, sqlc.arg(after_key)::text, sqlc.narg(after_id)::uuid))
ORDER BY rank, t.term_key, t.id
LIMIT sqlc.arg(row_limit);

-- name: RehomeTerms :execrows
-- Detach (spinoff): the terms saved on the lines that leave follow them into
-- the new conversation, as memos do (the new conversation has none yet).
UPDATE tangent_term SET root_line_id = sqlc.arg(root_line_id)
WHERE root_line_id = sqlc.arg(old_root_line_id) AND source_line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: DropCollidingTerms :execrows
-- Attach: a term the target conversation already has keeps the target's;
-- the source's one goes.
DELETE FROM tangent_term s
WHERE s.root_line_id = sqlc.arg(from_root)
  AND EXISTS (SELECT 1 FROM tangent_term t WHERE t.root_line_id = sqlc.arg(to_root) AND t.term_key = s.term_key);

-- name: MoveTreeTerms :execrows
-- Attach: the rest of the source conversation's terms move to the target.
UPDATE tangent_term SET root_line_id = sqlc.arg(to_root) WHERE root_line_id = sqlc.arg(from_root);

-- name: RepointTermSources :exec
-- Continuing an aside (B23) replaces its line: the terms saved from it name
-- the new line, which holds the same messages.
UPDATE tangent_term SET source_line_id = sqlc.arg(to_line) WHERE source_line_id = sqlc.arg(from_line);
