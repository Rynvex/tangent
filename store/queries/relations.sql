-- Relations (B9): rows of tangent_link with kind relation.

-- name: CountRelationsOfLines :one
-- Relations from or to any of the lines.
SELECT count(*)::int FROM tangent_link
WHERE kind = 'relation' AND (from_line_id = ANY(sqlc.arg(line_ids)::uuid[]) OR to_line_id = ANY(sqlc.arg(line_ids)::uuid[]));

-- name: FindRelation :one
-- A relation between the same two places, in either direction. A message
-- end is the message (ids are global; its line may have changed since, a
-- move does not touch the link); a line end is the line.
SELECT id FROM tangent_link
WHERE kind = 'relation' AND (
    (CASE WHEN sqlc.narg(a_message_id)::uuid IS NULL THEN from_message_id IS NULL AND from_line_id = sqlc.arg(a_line_id)
          ELSE from_message_id = sqlc.narg(a_message_id)::uuid END
     AND CASE WHEN sqlc.narg(b_message_id)::uuid IS NULL THEN to_message_id IS NULL AND to_line_id = sqlc.arg(b_line_id)
          ELSE to_message_id = sqlc.narg(b_message_id)::uuid END)
 OR (CASE WHEN sqlc.narg(b_message_id)::uuid IS NULL THEN from_message_id IS NULL AND from_line_id = sqlc.arg(b_line_id)
          ELSE from_message_id = sqlc.narg(b_message_id)::uuid END
     AND CASE WHEN sqlc.narg(a_message_id)::uuid IS NULL THEN to_message_id IS NULL AND to_line_id = sqlc.arg(a_line_id)
          ELSE to_message_id = sqlc.narg(a_message_id)::uuid END))
LIMIT 1;

-- name: GetLink :one
SELECT * FROM tangent_link WHERE id = $1;

-- name: DeleteLink :exec
DELETE FROM tangent_link WHERE id = $1;

-- name: RehomeLinkEnds :exec
-- Points the line ends of links at the line their message is on now, for
-- messages on the given lines (a detach takes those lines to a new tree).
UPDATE tangent_link k SET
    from_line_id = coalesce((SELECT m.line_id FROM tangent_message m WHERE m.id = k.from_message_id AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[])), k.from_line_id),
    to_line_id = coalesce((SELECT m.line_id FROM tangent_message m WHERE m.id = k.to_message_id AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[])), k.to_line_id)
WHERE k.from_message_id IN (SELECT id FROM tangent_message WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]))
   OR k.to_message_id IN (SELECT id FROM tangent_message WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]));

-- name: UpdateRelation :one
-- A relation's label and kind (B15), both written as given.
UPDATE tangent_link SET label = sqlc.arg(label), relation_kind = sqlc.arg(relation_kind)
WHERE id = sqlc.arg(id) AND kind = 'relation'
RETURNING *;

-- name: ListLinkEndsOfLines :many
-- Every link (spinoff or relation) with an end on one of the lines, oldest
-- first (B23: they go with a deleted branch).
SELECT id, from_line_id, to_line_id FROM tangent_link
WHERE from_line_id = ANY(sqlc.arg(line_ids)::uuid[]) OR to_line_id = ANY(sqlc.arg(line_ids)::uuid[])
ORDER BY created_at, id;
