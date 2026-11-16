-- The fisheye context (B9 part B).

-- name: ListPinnedMessages :many
-- A line's pinned messages, newest first.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND pinned
ORDER BY seq DESC
LIMIT sqlc.arg(row_limit);

-- name: ListFisheyeTree :many
-- Every branch of a tree with what the fisheye (and the relation and group
-- suggestions) see of it: the parent (for the distance), the purpose, the
-- card's conclusion, the leaf and whether it has a reply.
SELECT b.line_id, b.parent_line_id, b.purpose, b.kind, b.status, b.conclusion_line,
       lf.kind AS leaf_kind, lf.line AS leaf_line,
       EXISTS (SELECT 1 FROM tangent_message m WHERE m.line_id = b.line_id AND m.role = 'assistant' AND m.status = 'done')::boolean AS has_reply
FROM tangent_branch b
LEFT JOIN tangent_leaf lf ON lf.line_id = b.line_id
WHERE b.root_line_id = sqlc.arg(root_line_id) AND b.tenant_id = sqlc.arg(tenant_id)
ORDER BY b.created_at, b.line_id;
