-- Lines: the conversation rows and their per-line counters.

-- name: InsertLine :one
INSERT INTO tangent_line (id, tenant_id, title, provider, model, host_meta, created_by, folder, tags)
VALUES (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(title), sqlc.arg(provider), sqlc.arg(model), sqlc.arg(host_meta), sqlc.arg(created_by),
    sqlc.arg(folder), sqlc.arg(tags)::text[])
RETURNING *;

-- name: GetLine :one
SELECT * FROM tangent_line WHERE id = $1;

-- name: GetLineForUpdate :one
-- Row lock: every write of a line, and the single-pending-turn guard, runs
-- under it. NO KEY UPDATE, so foreign-key checks of rows that reference the
-- line (KEY SHARE) never wait on it: that wait is what deadlocked against
-- the lock order root → parent → child.
SELECT * FROM tangent_line WHERE id = $1 FOR NO KEY UPDATE;

-- name: GetLinesByIDs :many
SELECT * FROM tangent_line WHERE id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: ListActiveMainLines :many
-- One keyset page of a tenant's main lines that are not archived, newest
-- activity first (idx_tangent_line_active). Branches are listed by their own
-- outline, never here.
SELECT l.* FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id)
  AND l.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
  AND (sqlc.narg(after_at)::timestamptz IS NULL
       OR (l.last_activity_at, l.id) < (sqlc.narg(after_at)::timestamptz, sqlc.narg(after_id)::uuid))
ORDER BY l.last_activity_at DESC, l.id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListArchivedMainLines :many
-- The same page over the archived main lines (idx_tangent_line_archived).
SELECT l.* FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id)
  AND l.archived_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
  AND (sqlc.narg(after_at)::timestamptz IS NULL
       OR (l.last_activity_at, l.id) < (sqlc.narg(after_at)::timestamptz, sqlc.narg(after_id)::uuid))
ORDER BY l.last_activity_at DESC, l.id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListFilteredMainLines :many
-- ListActiveMainLines / ListArchivedMainLines with a folder or tag filter
-- (B18); only used when one is given, so the unfiltered list keeps its
-- queries and indexes. folder NULL: any folder ('' = unfiled); tag NULL: any.
SELECT l.* FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id)
  AND (l.archived_at IS NOT NULL) = sqlc.arg(archived)::boolean
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
  AND (sqlc.narg(folder)::text IS NULL OR l.folder = sqlc.narg(folder)::text)
  AND (sqlc.narg(tag)::text IS NULL OR l.tags @> ARRAY[sqlc.narg(tag)::text])
  AND (sqlc.narg(after_at)::timestamptz IS NULL
       OR (l.last_activity_at, l.id) < (sqlc.narg(after_at)::timestamptz, sqlc.narg(after_id)::uuid))
ORDER BY l.last_activity_at DESC, l.id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListPinnedMainLines :many
-- The tenant's pinned main lines (B25: GET /lines?pinned=true), newest pin
-- first, with the archived state and the optional folder and tag filters of
-- ListFilteredMainLines; one page only (tangent_line_pinned).
SELECT l.* FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id)
  AND l.pinned_at IS NOT NULL
  AND (l.archived_at IS NOT NULL) = sqlc.arg(archived)::boolean
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
  AND (sqlc.narg(folder)::text IS NULL OR l.folder = sqlc.narg(folder)::text)
  AND (sqlc.narg(tag)::text IS NULL OR l.tags @> ARRAY[sqlc.narg(tag)::text])
ORDER BY l.pinned_at DESC, l.id DESC
LIMIT sqlc.arg(row_limit);

-- name: SetLinePinned :exec
-- Pins a line (an already pinned one keeps its time) or unpins it; not
-- activity (B25).
UPDATE tangent_line
SET pinned_at = CASE WHEN sqlc.arg(pinned)::boolean THEN coalesce(pinned_at, clock_timestamp()) ELSE NULL END
WHERE id = sqlc.arg(id);

-- name: LockFolderLines :many
-- The tenant's main lines in a folder (archived ones too), locked in id
-- order (B18: renaming a folder).
SELECT l.id FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id) AND l.folder = sqlc.arg(folder)
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
ORDER BY l.id
FOR NO KEY UPDATE OF l;

-- name: SetLinesFolder :execrows
-- Moves locked main lines to another folder; the activity time stays.
UPDATE tangent_line SET folder = sqlc.arg(folder), updated_at = now()
WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: ListRelatedMainLines :many
-- Other main lines of the tenant that share a tag or the (non-empty)
-- folder, not archived, most shared tags then newest activity first (B18:
-- the related lines of a decompose plan).
SELECT l.id, l.title, l.folder, l.tags,
       COALESCE((SELECT array_agg(t ORDER BY t) FROM unnest(l.tags) AS t WHERE t = ANY(sqlc.arg(tags)::text[])), '{}')::text[] AS shared_tags
FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id) AND l.id <> sqlc.arg(line_id) AND l.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
  AND (l.tags && sqlc.arg(tags)::text[] OR (sqlc.arg(folder)::text <> '' AND l.folder = sqlc.arg(folder)::text))
ORDER BY cardinality(ARRAY(SELECT unnest(l.tags) INTERSECT SELECT unnest(sqlc.arg(tags)::text[]))) DESC,
         l.last_activity_at DESC, l.id DESC
LIMIT sqlc.arg(row_limit);

-- name: UpdateLineFields :one
UPDATE tangent_line
SET title = sqlc.arg(title), provider = sqlc.arg(provider), model = sqlc.arg(model),
    host_meta = sqlc.arg(host_meta), folder = sqlc.arg(folder), tags = sqlc.arg(tags)::text[], updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: SetLineStatus :one
UPDATE tangent_line SET status = $2, status_detail = $3, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: TouchLine :exec
UPDATE tangent_line SET last_activity_at = now(), updated_at = now() WHERE id = $1;

-- name: BumpLineUnread :exec
UPDATE tangent_line SET unread = unread + 1, last_activity_at = now(), updated_at = now() WHERE id = $1;

-- name: ResetLineUnread :exec
UPDATE tangent_line SET unread = 0, updated_at = now() WHERE id = $1 AND unread <> 0;

-- name: ApplyTurnToLine :one
-- Rolls a finished turn into the line: usage totals, one more unread
-- message, the new status and fresh activity.
UPDATE tangent_line
SET input_tokens = input_tokens + sqlc.arg(input_tokens)::bigint,
    output_tokens = output_tokens + sqlc.arg(output_tokens)::bigint,
    cost_usd = cost_usd + sqlc.arg(cost_usd)::double precision,
    unread = unread + 1,
    status = sqlc.arg(status),
    status_detail = sqlc.arg(status_detail),
    last_activity_at = now(),
    updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: ArchiveLines :many
UPDATE tangent_line
SET archived_at = CASE WHEN sqlc.arg(archived)::boolean THEN COALESCE(archived_at, now()) ELSE NULL END,
    updated_at = now()
WHERE id = ANY(sqlc.arg(line_ids)::uuid[])
RETURNING *;

-- name: DeleteLines :exec
DELETE FROM tangent_line WHERE tenant_id = sqlc.arg(tenant_id) AND id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: CountBusyLines :one
-- Lines of a set that are answering or have a turn waiting.
SELECT count(*)::int FROM tangent_line l
WHERE l.id = ANY(sqlc.arg(line_ids)::uuid[])
  AND (l.status = 'thinking' OR EXISTS (
        SELECT 1 FROM tangent_message m WHERE m.line_id = l.id AND m.status = 'pending'));

-- name: SetLineSummary :one
-- Writes the rolling summary and the seq it covers (NULL clears both).
UPDATE tangent_line
SET summary = sqlc.narg(summary), summary_upto_seq = sqlc.narg(summary_upto_seq), updated_at = now()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: ResetLineSummary :exec
UPDATE tangent_line SET summary = NULL, summary_upto_seq = NULL, updated_at = now() WHERE id = $1;

-- name: BumpNotesRevision :one
UPDATE tangent_line SET notes_revision = notes_revision + 1 WHERE id = $1 RETURNING notes_revision;

-- name: GetNotesRevisions :one
SELECT r.notes_revision AS revision, l.notes_revision_sent AS sent
FROM tangent_line r, tangent_line l
WHERE r.id = sqlc.arg(root_id) AND l.id = sqlc.arg(line_id);

-- name: SetNotesRevisionSent :exec
UPDATE tangent_line SET notes_revision_sent = $2 WHERE id = $1;

-- name: ListBranchesByLineIDs :many
-- Hydrates LineView.ConversationBranch for a page of lines.
SELECT * FROM tangent_branch WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: CountBranchesByParents :many
-- Direct branches per parent and status, for LineView.BranchCounts.
SELECT parent_line_id, status, count(*)::int AS branch_count
FROM tangent_branch
WHERE parent_line_id = ANY(sqlc.arg(parent_ids)::uuid[])
GROUP BY parent_line_id, status;

-- name: ListBranchUnreadByAncestors :many
-- For each line of the page: the unread messages of every open branch below
-- it and how many of those branches have a ready card draft (awaiting the
-- operator's review), at most max_depth levels down.
WITH RECURSIVE sub(ancestor_id, line_id, depth) AS (
    SELECT b.parent_line_id, b.line_id, 1 FROM tangent_branch b
    WHERE b.parent_line_id = ANY(sqlc.arg(line_ids)::uuid[])
    UNION ALL
    SELECT sub.ancestor_id, b.line_id, sub.depth + 1
    FROM sub JOIN tangent_branch b ON b.parent_line_id = sub.line_id
    WHERE sub.depth < sqlc.arg(max_depth)::int
)
SELECT sub.ancestor_id::uuid AS ancestor_id, COALESCE(SUM(l.unread), 0)::int AS unread,
       (COUNT(*) FILTER (WHERE b.draft_status = 'ready'))::int AS awaiting_review
FROM sub
JOIN tangent_branch b ON b.line_id = sub.line_id AND b.status = 'open'
JOIN tangent_line l ON l.id = sub.line_id
GROUP BY sub.ancestor_id;

-- name: AddLineUsage :exec
-- Adds the usage of a turn that finished without CompleteTurn (cancelled,
-- timed out) to the line's totals.
UPDATE tangent_line
SET input_tokens = input_tokens + sqlc.arg(input_tokens)::bigint,
    output_tokens = output_tokens + sqlc.arg(output_tokens)::bigint,
    cost_usd = cost_usd + sqlc.arg(cost_usd)::double precision,
    updated_at = now()
WHERE id = sqlc.arg(id);

-- name: ListTenantFolders :many
-- The tenant's non-empty folders of main lines with their active and
-- archived counts, by name (B18.1: GET /lines/organization). COLLATE "C"
-- keeps the order the same on every database (code point order).
SELECT l.folder::text AS folder,
       COUNT(*) FILTER (WHERE l.archived_at IS NULL)::bigint AS active_count,
       COUNT(*) FILTER (WHERE l.archived_at IS NOT NULL)::bigint AS archived_count
FROM tangent_line l
WHERE l.tenant_id = sqlc.arg(tenant_id) AND l.folder <> ''
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
GROUP BY l.folder
ORDER BY l.folder COLLATE "C" ASC;

-- name: ListTenantTags :many
-- The tags of the tenant's unarchived main lines with how many lines carry
-- each, most used first, then by name (B18.1: GET /lines/organization).
SELECT t.tag::text AS tag, COUNT(DISTINCT l.id)::bigint AS line_count
FROM tangent_line l
CROSS JOIN LATERAL unnest(l.tags) AS t(tag)
WHERE l.tenant_id = sqlc.arg(tenant_id) AND l.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM tangent_branch b WHERE b.line_id = l.id)
GROUP BY t.tag
ORDER BY line_count DESC, t.tag COLLATE "C" ASC;

-- name: DateImportedLine :exec
-- Dates an imported line like its source (B19): when it started, and its
-- last activity (its last message).
UPDATE tangent_line
SET created_at = sqlc.arg(created_at), last_activity_at = sqlc.arg(last_activity_at), updated_at = sqlc.arg(last_activity_at)
WHERE id = sqlc.arg(id);
