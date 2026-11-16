-- Folds of a line (the fold feature, B10 part A).

-- name: InsertFold :one
INSERT INTO tangent_fold (tenant_id, line_id, from_message_id, to_message_id, from_seq, to_seq, summary,
    message_count, tokens_original, tokens_summary, status, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(line_id), sqlc.arg(from_message_id), sqlc.arg(to_message_id), sqlc.arg(from_seq), sqlc.arg(to_seq),
    sqlc.arg(summary), sqlc.arg(message_count), sqlc.arg(tokens_original), sqlc.arg(tokens_summary), sqlc.arg(status), sqlc.arg(created_by))
RETURNING *;

-- name: GetFold :one
SELECT * FROM tangent_fold WHERE id = $1;

-- name: GetFoldForUpdate :one
SELECT * FROM tangent_fold WHERE id = $1 FOR UPDATE;

-- name: ListLiveFolds :many
-- A line's drafting and active folds whose two end messages are still on
-- it, in seq order (a fold whose ends left the line does not count).
SELECT f.* FROM tangent_fold f
JOIN tangent_message a ON a.id = f.from_message_id AND a.line_id = f.line_id
JOIN tangent_message b ON b.id = f.to_message_id AND b.line_id = f.line_id
WHERE f.line_id = sqlc.arg(line_id) AND f.status IN ('drafting','active')
ORDER BY f.from_seq, f.id;

-- name: ListLineFolds :many
-- A line's folds that were not removed (failed ones included), whose two
-- end messages are still on it, in seq order.
SELECT f.* FROM tangent_fold f
JOIN tangent_message a ON a.id = f.from_message_id AND a.line_id = f.line_id
JOIN tangent_message b ON b.id = f.to_message_id AND b.line_id = f.line_id
WHERE f.line_id = sqlc.arg(line_id) AND f.status <> 'removed'
ORDER BY f.from_seq, f.id;

-- name: ListLineMessagesInSeqRange :many
-- The messages of a line from one seq to another, in seq order.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq BETWEEN sqlc.arg(from_seq)::bigint AND sqlc.arg(to_seq)::bigint
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: SetFoldJob :one
UPDATE tangent_fold SET source_job_id = sqlc.arg(job_id), updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: FinishFoldSummary :one
-- Writes a summary job's outcome on the drafting fold it was started for.
UPDATE tangent_fold SET summary = sqlc.arg(summary), tokens_summary = sqlc.arg(tokens_summary), status = sqlc.arg(status),
    updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND source_job_id = sqlc.arg(job_id) AND status = 'drafting'
RETURNING *;

-- name: FailFoldOfJob :one
-- The drafting fold whose summary job timed out.
UPDATE tangent_fold SET status = 'failed', updated_at = clock_timestamp()
WHERE source_job_id = $1 AND status = 'drafting'
RETURNING *;

-- name: RemoveFold :one
UPDATE tangent_fold SET status = 'removed', updated_at = clock_timestamp() WHERE id = $1 RETURNING *;

-- name: ListFoldEnds :many
-- The drafting and active folds of the lines with the line each end message
-- is on now (NULL once it is gone).
SELECT f.id, f.line_id, a.line_id AS from_line_id, b.line_id AS to_line_id
FROM tangent_fold f
LEFT JOIN tangent_message a ON a.id = f.from_message_id
LEFT JOIN tangent_message b ON b.id = f.to_message_id
WHERE f.line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND f.status IN ('drafting','active')
ORDER BY f.id;

-- name: RehomeFold :one
UPDATE tangent_fold SET line_id = sqlc.arg(line_id), updated_at = clock_timestamp() WHERE id = sqlc.arg(id) RETURNING *;

-- name: ListTakenSuggestionTargets :many
-- Which of the target keys already have an open or a dismissed suggestion
-- of the kind in the conversation.
SELECT DISTINCT target_key FROM tangent_suggestion
WHERE root_line_id = sqlc.arg(root_line_id) AND feature = sqlc.arg(feature) AND kind = sqlc.arg(kind)
  AND target_key = ANY(sqlc.arg(target_keys)::text[]) AND status IN ('open','dismissed');

-- name: UpdateFoldSummary :one
-- The operator's summary: the fold applies and no job writes it any more.
UPDATE tangent_fold SET summary = sqlc.arg(summary), tokens_summary = sqlc.arg(tokens_summary), status = 'active', source_job_id = NULL,
    updated_at = clock_timestamp()
WHERE id = sqlc.arg(id) RETURNING *;

-- name: ListTreeFolds :many
-- ListLineFolds for several lines at once (an export, B14), in line then
-- seq order.
SELECT f.* FROM tangent_fold f
JOIN tangent_message a ON a.id = f.from_message_id AND a.line_id = f.line_id
JOIN tangent_message b ON b.id = f.to_message_id AND b.line_id = f.line_id
WHERE f.tenant_id = sqlc.arg(tenant_id) AND f.line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND f.status <> 'removed'
ORDER BY f.line_id, f.from_seq, f.id;

-- name: RemoveFoldsAcross :many
-- The folds of a line (not removed) that overlap a seq range without lying
-- inside it (B18: an extract cut them or would sit inside them).
UPDATE tangent_fold SET status = 'removed', updated_at = clock_timestamp()
WHERE line_id = sqlc.arg(line_id) AND status <> 'removed'
  AND from_seq <= sqlc.arg(to_seq)::bigint AND to_seq >= sqlc.arg(from_seq)::bigint
  AND NOT (from_seq >= sqlc.arg(from_seq)::bigint AND to_seq <= sqlc.arg(to_seq)::bigint)
RETURNING *;

-- name: RehomeFoldsWithin :many
-- The folds of a line (not removed) inside a seq range go to the line the
-- range moved to (B18: an extract).
UPDATE tangent_fold SET line_id = sqlc.arg(to_line), updated_at = clock_timestamp()
WHERE line_id = sqlc.arg(from_line) AND status <> 'removed'
  AND from_seq >= sqlc.arg(from_seq)::bigint AND to_seq <= sqlc.arg(to_seq)::bigint
RETURNING *;

-- name: RenumberFoldEnds :exec
-- A renumbered message's new seq on the folds that end or start at it.
UPDATE tangent_fold
SET from_seq = CASE WHEN from_message_id = sqlc.arg(message_id) THEN sqlc.arg(seq)::bigint ELSE from_seq END,
    to_seq = CASE WHEN to_message_id = sqlc.arg(message_id) THEN sqlc.arg(seq)::bigint ELSE to_seq END
WHERE from_message_id = sqlc.arg(message_id) OR to_message_id = sqlc.arg(message_id);
