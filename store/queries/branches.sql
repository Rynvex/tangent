-- Branches: the tree structure, the outline, drafting and ending.

-- name: InsertBranch :one
INSERT INTO tangent_branch (
    line_id, tenant_id, parent_line_id, root_line_id, anchor_message_id,
    excerpt, purpose, kind, depth, origin, pack, created_by
)
VALUES (
    sqlc.arg(line_id), sqlc.arg(tenant_id), sqlc.arg(parent_line_id), sqlc.arg(root_line_id), sqlc.arg(anchor_message_id),
    sqlc.arg(excerpt), sqlc.arg(purpose), sqlc.arg(kind), sqlc.arg(depth), sqlc.arg(origin), sqlc.arg(pack), sqlc.arg(created_by)
)
RETURNING *;

-- name: GetBranch :one
SELECT * FROM tangent_branch WHERE line_id = $1;

-- name: GetBranchView :one
-- One branch with the line fields the outline shows.
SELECT sqlc.embed(b),
       l.provider AS line_provider,
       l.model AS line_model,
       l.status AS line_status,
       l.unread AS line_unread,
       l.last_activity_at AS line_last_activity_at,
       l.archived_at AS line_archived_at,
       (SELECT count(*) FROM tangent_message m
         WHERE m.line_id = b.line_id AND m.status <> 'pending')::int AS message_count,
       lf.kind AS leaf_kind,
       lf.line AS leaf_line,
       lf.status AS leaf_status,
       mt.kind AS anchor_tag_kind,
       mt.source AS anchor_tag_source,
       mt.status AS anchor_tag_status,
       mt.updated_at AS anchor_tag_updated_at,
       -- A CASE so sqlc types it as nullable (a bare cast reads as NOT NULL).
       CASE WHEN cm.meta ->> 'editedAt' IS NOT NULL THEN (cm.meta ->> 'editedAt')::timestamptz END AS card_edited_at
FROM tangent_branch b
JOIN tangent_line l ON l.id = b.line_id
LEFT JOIN tangent_leaf lf ON lf.line_id = b.line_id
LEFT JOIN tangent_message_tag mt ON mt.message_id = b.anchor_message_id
LEFT JOIN tangent_message cm ON cm.id = b.card_message_id
WHERE b.line_id = sqlc.arg(line_id) AND b.tenant_id = sqlc.arg(tenant_id);

-- name: ListBranchViewsByRoot :many
-- The whole tree as a flat adjacency list, oldest first, asides only when asked.
SELECT sqlc.embed(b),
       l.provider AS line_provider,
       l.model AS line_model,
       l.status AS line_status,
       l.unread AS line_unread,
       l.last_activity_at AS line_last_activity_at,
       l.archived_at AS line_archived_at,
       (SELECT count(*) FROM tangent_message m
         WHERE m.line_id = b.line_id AND m.status <> 'pending')::int AS message_count,
       lf.kind AS leaf_kind,
       lf.line AS leaf_line,
       lf.status AS leaf_status,
       mt.kind AS anchor_tag_kind,
       mt.source AS anchor_tag_source,
       mt.status AS anchor_tag_status,
       mt.updated_at AS anchor_tag_updated_at,
       -- A CASE so sqlc types it as nullable (a bare cast reads as NOT NULL).
       CASE WHEN cm.meta ->> 'editedAt' IS NOT NULL THEN (cm.meta ->> 'editedAt')::timestamptz END AS card_edited_at
FROM tangent_branch b
JOIN tangent_line l ON l.id = b.line_id
LEFT JOIN tangent_leaf lf ON lf.line_id = b.line_id
LEFT JOIN tangent_message_tag mt ON mt.message_id = b.anchor_message_id
LEFT JOIN tangent_message cm ON cm.id = b.card_message_id
WHERE b.root_line_id = sqlc.arg(root_line_id) AND b.tenant_id = sqlc.arg(tenant_id)
  AND (sqlc.arg(include_aside)::boolean OR b.kind <> 'aside')
ORDER BY b.created_at, b.line_id
LIMIT sqlc.arg(row_limit);

-- name: CountOpenBranchesForParent :one
SELECT count(*)::int FROM tangent_branch WHERE parent_line_id = $1 AND status = 'open';

-- name: CountBranchesForRoot :one
SELECT count(*)::int FROM tangent_branch WHERE root_line_id = $1;

-- name: ListSubtreeLineIDs :many
-- Every descendant line of a line (the line itself excluded), at most
-- max_depth levels down.
WITH RECURSIVE sub(line_id, depth) AS (
    SELECT b.line_id, 1 FROM tangent_branch b WHERE b.parent_line_id = sqlc.arg(parent_line_id)
    UNION ALL
    SELECT b.line_id, sub.depth + 1 FROM tangent_branch b JOIN sub ON b.parent_line_id = sub.line_id
    WHERE sub.depth < sqlc.arg(max_depth)::int
)
SELECT sub.line_id::uuid FROM sub;

-- name: ListTreeLineIDs :many
-- Every branch line of a main line's tree, in id order (the lock order).
SELECT line_id FROM tangent_branch WHERE root_line_id = $1 ORDER BY line_id;

-- name: CloseBranch :one
-- Ends an open branch: merged (with its card and one-line conclusion), discarded or promoted.
UPDATE tangent_branch
SET status = sqlc.arg(status), conclusion_line = sqlc.arg(conclusion_line), card_message_id = sqlc.narg(card_message_id),
    closed_at = clock_timestamp(), updated_at = now()
WHERE line_id = sqlc.arg(line_id) AND status = 'open'
RETURNING *;

-- name: ListBranchesAnchoredIn :many
-- Direct branches of a line whose anchor is one of the given messages.
SELECT line_id FROM tangent_branch
WHERE parent_line_id = sqlc.arg(parent_line_id) AND anchor_message_id = ANY(sqlc.arg(message_ids)::uuid[])
ORDER BY line_id;

-- name: ListBranchesAnchoredInLine :many
-- Direct branches of a line whose anchor message now belongs to another line.
SELECT b.line_id FROM tangent_branch b
JOIN tangent_message m ON m.id = b.anchor_message_id
WHERE b.parent_line_id = sqlc.arg(parent_line_id) AND m.line_id = sqlc.arg(message_line_id)
ORDER BY b.line_id;

-- name: ListChildBranchIDs :many
SELECT line_id FROM tangent_branch WHERE parent_line_id = $1 ORDER BY line_id;

-- name: ReparentBranches :exec
UPDATE tangent_branch SET parent_line_id = sqlc.arg(parent_line_id), updated_at = now()
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: ShiftBranchDepths :exec
UPDATE tangent_branch SET depth = depth + sqlc.arg(delta)::int, updated_at = now()
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: ListBranchAnchorsInLine :many
-- Direct branches of a line whose anchor message is still on that line.
SELECT b.line_id, b.anchor_message_id FROM tangent_branch b
JOIN tangent_message m ON m.id = b.anchor_message_id
WHERE b.parent_line_id = sqlc.arg(line_id) AND m.line_id = sqlc.arg(line_id)
ORDER BY b.created_at, b.line_id;

-- name: ListExpiredAsides :many
-- Asides that ended before the cutoff and are not kept (B23), oldest first.
SELECT line_id, root_line_id FROM tangent_branch
WHERE kind = 'aside' AND status <> 'open' AND closed_at < sqlc.arg(cutoff) AND kept_at IS NULL
ORDER BY closed_at, line_id
LIMIT sqlc.arg(row_limit);

-- name: ClaimBranchDraft :one
-- Starts a draft; the branch line is already locked.
UPDATE tangent_branch
SET draft_status = 'drafting', draft = '{}'::jsonb, draft_job_id = sqlc.arg(draft_job_id)::uuid,
    draft_started_at = sqlc.arg(draft_started_at), draft_upto_seq = sqlc.arg(draft_upto_seq),
    draft_parent_tip_message_id = sqlc.narg(draft_parent_tip_message_id), updated_at = now()
WHERE line_id = sqlc.arg(line_id) AND status = 'open'
RETURNING *;

-- name: FinishBranchDraft :one
-- Stores the outcome of the draft the given job was started for. Matches
-- nothing when the draft was superseded or timed out, or the branch closed.
UPDATE tangent_branch
SET draft_status = sqlc.arg(draft_status), draft = sqlc.arg(draft), updated_at = now()
WHERE line_id = sqlc.arg(line_id) AND status = 'open' AND draft_status = 'drafting'
  AND draft_job_id = sqlc.arg(draft_job_id)::uuid
  AND draft_started_at > sqlc.arg(started_after)
RETURNING *;

-- name: ListBranchPurposes :many
SELECT line_id, purpose FROM tangent_branch
WHERE tenant_id = sqlc.arg(tenant_id) AND line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: RenameBranch :one
-- Changes the purpose of an open or ended branch and the title of its line
-- with it (B13: not a promoted branch, not the previous main line).
WITH renamed AS (
    UPDATE tangent_branch SET purpose = sqlc.arg(purpose), updated_at = now()
    WHERE line_id = sqlc.arg(line_id) AND status IN ('open', 'merged', 'discarded') AND origin <> 'previous_main_line'
    RETURNING line_id
)
UPDATE tangent_line l SET title = sqlc.arg(purpose), updated_at = now()
FROM renamed WHERE l.id = renamed.line_id
RETURNING l.id;

-- name: ListSubtreesLineIDs :many
-- Every descendant line of a set of lines (the lines themselves excluded),
-- at most max_depth levels down: one walk for many subtrees.
WITH RECURSIVE sub(line_id, depth) AS (
    SELECT b.line_id, 1 FROM tangent_branch b WHERE b.parent_line_id = ANY(sqlc.arg(parent_line_ids)::uuid[])
    UNION ALL
    SELECT b.line_id, sub.depth + 1 FROM tangent_branch b JOIN sub ON b.parent_line_id = sub.line_id
    WHERE sub.depth < sqlc.arg(max_depth)::int
)
SELECT sub.line_id::uuid FROM sub;

-- name: ListBranchViewsByLineIDs :many
-- The outline rows of a set of branches of one tenant (events after a
-- write that touched many).
SELECT sqlc.embed(b),
       l.provider AS line_provider,
       l.model AS line_model,
       l.status AS line_status,
       l.unread AS line_unread,
       l.last_activity_at AS line_last_activity_at,
       l.archived_at AS line_archived_at,
       (SELECT count(*) FROM tangent_message m
         WHERE m.line_id = b.line_id AND m.status <> 'pending')::int AS message_count,
       lf.kind AS leaf_kind,
       lf.line AS leaf_line,
       lf.status AS leaf_status,
       mt.kind AS anchor_tag_kind,
       mt.source AS anchor_tag_source,
       mt.status AS anchor_tag_status,
       mt.updated_at AS anchor_tag_updated_at,
       -- A CASE so sqlc types it as nullable (a bare cast reads as NOT NULL).
       CASE WHEN cm.meta ->> 'editedAt' IS NOT NULL THEN (cm.meta ->> 'editedAt')::timestamptz END AS card_edited_at
FROM tangent_branch b
JOIN tangent_line l ON l.id = b.line_id
LEFT JOIN tangent_leaf lf ON lf.line_id = b.line_id
LEFT JOIN tangent_message_tag mt ON mt.message_id = b.anchor_message_id
LEFT JOIN tangent_message cm ON cm.id = b.card_message_id
WHERE b.line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND b.tenant_id = sqlc.arg(tenant_id);

-- name: SetBranchConclusionLine :execrows
-- A merged branch's conclusion line after its card was edited (B17).
UPDATE tangent_branch SET conclusion_line = sqlc.arg(conclusion_line), updated_at = now()
WHERE line_id = sqlc.arg(line_id) AND status = 'merged';

-- name: CountCardsOnLineOfBranchesAnchoredIn :one
-- Branches of a line, opened on one of the messages, whose conclusion card
-- is still on that line (B18: an extract would take the branch but leave
-- its card behind).
SELECT count(*)::int FROM tangent_branch b
JOIN tangent_message m ON m.id = b.card_message_id
WHERE b.parent_line_id = sqlc.arg(parent_line_id) AND b.anchor_message_id = ANY(sqlc.arg(message_ids)::uuid[])
  AND m.line_id = sqlc.arg(parent_line_id);

-- name: DateImportedBranch :exec
-- Dates an imported branch like its line (B19): it started with it and, once
-- closed, closed at its last activity.
UPDATE tangent_branch
SET created_at = sqlc.arg(created_at),
    closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE sqlc.arg(closed_at)::timestamptz END
WHERE line_id = sqlc.arg(line_id);

-- name: SetBranchKept :one
-- Keeps a branch (an aside) from the purge, or lets the purge have it again
-- (B23). The caller writes only when the state changes.
UPDATE tangent_branch
SET kept_at = CASE WHEN sqlc.arg(keep)::boolean THEN clock_timestamp() END, updated_at = now()
WHERE line_id = sqlc.arg(line_id)
RETURNING *;
