-- Rebalance signals (B8 part B).

-- name: CountReplies :one
-- Finished assistant chat replies of a line after a seq.
SELECT count(*)::int FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq > sqlc.arg(after_seq)::bigint AND role = 'assistant' AND status = 'done' AND kind = 'chat';

-- name: NthLatestReplySeq :one
-- The seq of a line's n-th latest finished reply (no row: fewer replies).
SELECT seq FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND role = 'assistant' AND status = 'done' AND kind = 'chat'
ORDER BY seq DESC OFFSET sqlc.arg(skip)::int LIMIT 1;

-- name: OtherRepliesAfter :one
-- Whether another line of the set has a finished reply after a seq.
SELECT EXISTS (
    SELECT 1 FROM tangent_message
    WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND line_id <> sqlc.arg(except_line_id)
      AND seq > sqlc.arg(after_seq)::bigint AND role = 'assistant' AND status = 'done' AND kind = 'chat'
)::boolean;
