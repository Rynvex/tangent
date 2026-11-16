-- Attaching a conversation to another one as a branch (B20), the inverse of
-- a detach. The whole source tree moves, so its tree-scoped rows move by
-- their old main line (root_line_id) rather than line by line.

-- name: AttachAnchorCandidate :one
-- The anchor an attach picks on its own: of the messages of the line a
-- branch may hang on (finished operator or assistant messages, conclusion
-- cards), the newest in seq order dated no later than at, else the newest.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND status = 'done' AND (role IN ('user', 'assistant') OR kind = 'branch_card')
ORDER BY (created_at <= sqlc.arg(at)::timestamptz) DESC, seq DESC
LIMIT 1;

-- name: AttachSourceOpening :one
-- How many finished operator and assistant chat messages a line has, and
-- the first operator one and the first of either (its default purpose).
SELECT count(*)::int AS chat_count,
       coalesce((SELECT f.content FROM tangent_message f
                 WHERE f.line_id = sqlc.arg(line_id) AND f.status = 'done' AND f.kind = 'chat' AND f.role = 'user'
                 ORDER BY f.seq LIMIT 1), '')::text AS first_user,
       coalesce((SELECT f.content FROM tangent_message f
                 WHERE f.line_id = sqlc.arg(line_id) AND f.status = 'done' AND f.kind = 'chat' AND f.role IN ('user', 'assistant')
                 ORDER BY f.seq LIMIT 1), '')::text AS first_any
FROM tangent_message m
WHERE m.line_id = sqlc.arg(line_id) AND m.status = 'done' AND m.kind = 'chat' AND m.role IN ('user', 'assistant');

-- name: MaxBranchDepthForRoot :one
-- The deepest branch of a tree (0 without branches).
SELECT coalesce(max(depth), 0)::int FROM tangent_branch WHERE root_line_id = $1;

-- name: ListDraftingInTree :many
-- The branches of a tree whose card draft is (or was left) running.
SELECT * FROM tangent_branch WHERE root_line_id = $1 AND draft_status = 'drafting';

-- name: MakeLineBranch :exec
-- The attached main line becomes a branch line: titled by its purpose,
-- without the folder, tags, origin capsule and pin of a main line. Its
-- import batch stays (B25: still counted in the batch, not standalone).
UPDATE tangent_line SET title = sqlc.arg(title), folder = '', tags = '{}', origin_capsule = NULL, pinned_at = NULL, updated_at = now()
WHERE id = sqlc.arg(id);

-- name: ResetNotesRevisionSent :exec
-- The lines of an attached tree last sent notes counted against their old
-- main line's revision; zero makes their next turn send the target's notes.
UPDATE tangent_line SET notes_revision_sent = 0 WHERE id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: ExpireCollidingSuggestions :many
-- Expires the open suggestions of the source tree that the target tree
-- already has open (one open suggestion per feature, kind and target).
UPDATE tangent_suggestion s SET status = 'expired', decided_at = clock_timestamp()
WHERE s.root_line_id = sqlc.arg(from_root) AND s.status = 'open' AND EXISTS (
    SELECT 1 FROM tangent_suggestion t
    WHERE t.root_line_id = sqlc.arg(to_root) AND t.status = 'open'
      AND t.feature = s.feature AND t.kind = s.kind AND t.target_key = s.target_key)
RETURNING *;

-- name: MoveTreeSuggestions :execrows
UPDATE tangent_suggestion SET root_line_id = sqlc.arg(to_root) WHERE root_line_id = sqlc.arg(from_root);

-- name: MoveTreeLeaves :execrows
UPDATE tangent_leaf SET root_line_id = sqlc.arg(to_root) WHERE root_line_id = sqlc.arg(from_root);

-- name: MoveTreeChapterCuts :execrows
UPDATE tangent_chapter_cut SET root_line_id = sqlc.arg(to_root) WHERE root_line_id = sqlc.arg(from_root);

-- name: MoveTreeSeeds :execrows
UPDATE tangent_seed SET root_line_id = sqlc.arg(to_root), updated_at = clock_timestamp() WHERE root_line_id = sqlc.arg(from_root);

-- name: MoveTreeMemos :execrows
-- Memos follow their conversation, those whose node is gone too.
UPDATE tangent_memo SET root_line_id = sqlc.arg(to_root) WHERE root_line_id = sqlc.arg(from_root);

-- name: MoveTreeNotes :execrows
-- Notes move (a detach copies them): they cite lines that come along.
UPDATE tangent_note SET root_line_id = sqlc.arg(to_root), updated_at = clock_timestamp() WHERE root_line_id = sqlc.arg(from_root);

-- name: MoveTreeGroups :many
UPDATE tangent_group SET root_line_id = sqlc.arg(to_root), updated_at = clock_timestamp() WHERE root_line_id = sqlc.arg(from_root)
RETURNING *;
