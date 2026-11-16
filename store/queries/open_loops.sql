-- Open loops (B9): read-only listings over a tenant or one conversation,
-- each with the total before its limit. Archived conversations are left out.

-- name: ListStaleBranches :many
SELECT b.line_id, r.title AS root_title, count(*) OVER ()::int AS total
FROM tangent_branch b
JOIN tangent_line l ON l.id = b.line_id
JOIN tangent_line r ON r.id = b.root_line_id
WHERE b.tenant_id = sqlc.arg(tenant_id) AND b.status = 'open' AND l.last_activity_at < sqlc.arg(idle_before)
  AND r.archived_at IS NULL AND (NOT sqlc.arg(one_root)::boolean OR b.root_line_id = sqlc.arg(root_line_id))
ORDER BY l.last_activity_at, b.line_id
LIMIT sqlc.arg(row_limit);

-- name: ListNotesToConfirm :many
SELECT sqlc.embed(n), r.title AS root_title, count(*) OVER ()::int AS total
FROM tangent_note n
JOIN tangent_line r ON r.id = n.root_line_id
WHERE n.tenant_id = sqlc.arg(tenant_id) AND n.section = 'to_confirm' AND n.status = 'active'
  AND r.archived_at IS NULL AND (NOT sqlc.arg(one_root)::boolean OR n.root_line_id = sqlc.arg(root_line_id))
ORDER BY n.created_at DESC, n.id
LIMIT sqlc.arg(row_limit);

-- name: ListOpenSeedsOfTenant :many
SELECT sqlc.embed(d), r.title AS root_title, count(*) OVER ()::int AS total
FROM tangent_seed d
JOIN tangent_line r ON r.id = d.root_line_id
WHERE d.tenant_id = sqlc.arg(tenant_id) AND d.status = 'open'
  AND r.archived_at IS NULL AND (NOT sqlc.arg(one_root)::boolean OR d.root_line_id = sqlc.arg(root_line_id))
ORDER BY d.created_at DESC, d.id
LIMIT sqlc.arg(row_limit);

-- name: ListOpenSuggestionsOfTenant :many
SELECT sqlc.embed(s), r.title AS root_title, count(*) OVER ()::int AS total
FROM tangent_suggestion s
JOIN tangent_line r ON r.id = s.root_line_id
WHERE s.tenant_id = sqlc.arg(tenant_id) AND s.status = 'open' AND s.feature = ANY(sqlc.arg(features)::text[])
  AND r.archived_at IS NULL AND (NOT sqlc.arg(one_root)::boolean OR s.root_line_id = sqlc.arg(root_line_id))
ORDER BY s.created_at DESC, s.id
LIMIT sqlc.arg(row_limit);
