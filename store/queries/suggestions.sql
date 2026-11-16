-- The suggestion inbox (B8).

-- name: GetSuggestion :one
SELECT * FROM tangent_suggestion WHERE id = $1;

-- name: GetSuggestionForUpdate :one
SELECT * FROM tangent_suggestion WHERE id = $1 FOR UPDATE;

-- name: LastDismissal :one
-- When the same suggestion was last dismissed (no row: never).
SELECT decided_at::timestamptz FROM tangent_suggestion
WHERE root_line_id = sqlc.arg(root_line_id) AND feature = sqlc.arg(feature) AND kind = sqlc.arg(kind)
  AND target_key = sqlc.arg(target_key) AND status = 'dismissed'
ORDER BY decided_at DESC LIMIT 1;

-- name: InsertSuggestion :one
-- Inserts an open suggestion unless one is open for the same target
-- (then no row comes back).
INSERT INTO tangent_suggestion (tenant_id, root_line_id, line_id, feature, kind, target_key, payload)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(line_id), sqlc.arg(feature), sqlc.arg(kind), sqlc.arg(target_key), sqlc.arg(payload))
ON CONFLICT (root_line_id, feature, kind, target_key) WHERE status = 'open' DO NOTHING
RETURNING *;

-- name: DecideSuggestion :one
UPDATE tangent_suggestion SET status = sqlc.arg(status), decided_at = clock_timestamp()
WHERE id = sqlc.arg(id) AND status = 'open'
RETURNING *;

-- name: ExpireSuggestionsForLines :many
-- Expires the open suggestions about lines that ended.
UPDATE tangent_suggestion SET status = 'expired', decided_at = clock_timestamp()
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND status = 'open'
RETURNING *;

-- name: ExpireSuggestionsOfEndedBranches :many
-- The maintenance sweep: open suggestions about a branch that has ended, or
-- about a line that left the suggestion's tree (a detached branch), missed
-- while the inbox was off for the tenant.
UPDATE tangent_suggestion SET status = 'expired', decided_at = clock_timestamp()
WHERE id IN (
    SELECT s.id FROM tangent_suggestion s
    LEFT JOIN tangent_branch b ON b.line_id = s.line_id
    WHERE s.status = 'open'
      AND ((b.line_id IS NOT NULL AND b.status <> 'open')
        OR (s.line_id <> s.root_line_id AND (b.line_id IS NULL OR b.root_line_id <> s.root_line_id)))
    LIMIT sqlc.arg(row_limit)
    FOR UPDATE OF s SKIP LOCKED
)
RETURNING *;

-- name: ListSuggestions :many
-- A conversation's suggestions of the given features and statuses, newest first.
SELECT * FROM tangent_suggestion
WHERE root_line_id = sqlc.arg(root_line_id) AND feature = ANY(sqlc.arg(features)::text[])
  AND status = ANY(sqlc.arg(statuses)::text[])
ORDER BY created_at DESC, id
LIMIT sqlc.arg(row_limit);

-- name: CountOpenInbox :many
-- The open suggestions (of the given features; all when filter is false),
-- open seeds and stale branches (open, idle since idle_before) of each main
-- line of a page.
SELECT r.id::uuid AS root_line_id,
       (SELECT count(*) FROM tangent_suggestion s WHERE s.root_line_id = r.id AND s.status = 'open'
          AND (NOT sqlc.arg(filter)::boolean OR s.feature = ANY(sqlc.arg(features)::text[])))::int AS suggestions,
       (SELECT count(*) FROM tangent_seed d WHERE d.root_line_id = r.id AND d.status = 'open')::int AS seeds,
       (SELECT count(*) FROM tangent_branch b JOIN tangent_line l ON l.id = b.line_id
         WHERE b.root_line_id = r.id AND b.status = 'open' AND l.last_activity_at < sqlc.arg(idle_before))::int AS stale_branches
FROM unnest(sqlc.arg(line_ids)::uuid[]) AS r(id);

-- name: ExpireOpenSuggestionsOfKind :many
-- Expires the open suggestions of one feature and kind in a conversation.
UPDATE tangent_suggestion SET status = 'expired', decided_at = clock_timestamp()
WHERE root_line_id = sqlc.arg(root_line_id) AND feature = sqlc.arg(feature) AND kind = sqlc.arg(kind) AND status = 'open'
RETURNING *;

-- name: ExpireSuggestionsNamingLines :many
-- Expires a conversation's open suggestions whose payload names one of the
-- lines (a relation's fromLineId / toLineId, a group's members[].lineId):
-- the lines left the tree (a detach took them, a purged aside went).
UPDATE tangent_suggestion SET status = 'expired', decided_at = clock_timestamp()
WHERE root_line_id = sqlc.arg(root_line_id) AND status = 'open' AND (
    payload->>'fromLineId' = ANY(sqlc.arg(line_ids)::text[])
    OR payload->>'toLineId' = ANY(sqlc.arg(line_ids)::text[])
    OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'members') = 'array' THEN payload->'members' ELSE '[]'::jsonb END) m
        WHERE m->>'lineId' = ANY(sqlc.arg(line_ids)::text[])))
RETURNING *;

-- name: CountLinesOutsideTree :one
-- How many of the lines are neither the root nor a branch of its tree
-- (another tree's, or gone).
SELECT count(*)::int FROM unnest(sqlc.arg(line_ids)::uuid[]) AS x(id)
WHERE x.id <> sqlc.arg(root_line_id)::uuid AND NOT EXISTS (
    SELECT 1 FROM tangent_branch b WHERE b.line_id = x.id AND b.root_line_id = sqlc.arg(root_line_id)::uuid);

-- name: DismissOpenSuggestions :many
-- Dismisses every open suggestion of a conversation raised by the given
-- features at once (B17); the cooldown applies as to a single dismissal.
UPDATE tangent_suggestion SET status = 'dismissed', decided_at = clock_timestamp()
WHERE root_line_id = sqlc.arg(root_line_id) AND feature = ANY(sqlc.arg(features)::text[]) AND status = 'open'
RETURNING *;
