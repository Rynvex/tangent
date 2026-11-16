-- Spinning conversations off (B8 part B).

-- name: SetLineCapsule :exec
-- The new main line of a spinoff: its capsule and title, and the folder and
-- tags of the conversation it came from (B18). It is neither pinned nor in
-- an import batch (B25; a detached line that was attached had both).
UPDATE tangent_line l SET origin_capsule = sqlc.arg(capsule), title = sqlc.arg(title), folder = r.folder, tags = r.tags,
    pinned_at = NULL, import_batch_id = NULL, import_seq = NULL, import_activity_at = NULL, updated_at = now()
FROM tangent_line r
WHERE l.id = sqlc.arg(id) AND r.id = sqlc.arg(old_root_id);

-- name: DeleteBranchRow :exec
DELETE FROM tangent_branch WHERE line_id = $1;

-- name: RehomeBranches :exec
-- Moves branches into another tree, raising them by shift levels.
UPDATE tangent_branch SET root_line_id = sqlc.arg(root_line_id), depth = depth - sqlc.arg(shift)::int, updated_at = now()
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: RehomeLeaves :exec
UPDATE tangent_leaf SET root_line_id = sqlc.arg(root_line_id) WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: RehomeSuggestions :exec
UPDATE tangent_suggestion SET root_line_id = sqlc.arg(root_line_id) WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: RehomeChapterCuts :exec
UPDATE tangent_chapter_cut SET root_line_id = sqlc.arg(root_line_id) WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: RehomeSeeds :execrows
-- Seeds of the old tree whose anchor message now sits on one of the lines.
UPDATE tangent_seed s SET root_line_id = sqlc.arg(root_line_id), updated_at = clock_timestamp()
FROM tangent_message m
WHERE s.root_line_id = sqlc.arg(old_root_line_id) AND m.id = s.anchor_message_id AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: NotesMissingLabels :many
-- Notes of a tree without a source label whose source line is one of the lines.
SELECT * FROM tangent_note
WHERE root_line_id = sqlc.arg(root_line_id) AND source_label = '' AND source_line_id = ANY(sqlc.arg(line_ids)::uuid[]);

-- name: SetNoteLabel :exec
UPDATE tangent_note SET source_label = sqlc.arg(source_label) WHERE id = sqlc.arg(id);

-- name: InsertCopiedNote :one
INSERT INTO tangent_note (tenant_id, root_line_id, section, text, source_line_id, source_message_id, source_card_message_id,
                          source_label, copied_from_note_id, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(root_line_id), sqlc.arg(section), sqlc.arg(text), sqlc.narg(source_line_id),
        sqlc.narg(source_message_id), sqlc.narg(source_card_message_id), sqlc.arg(source_label), sqlc.arg(copied_from_note_id), sqlc.arg(created_by))
RETURNING *;

-- name: InsertLink :one
-- relation_kind matters for relations only (B15); a spinoff link keeps related.
INSERT INTO tangent_link (tenant_id, kind, from_line_id, from_message_id, to_line_id, to_message_id, label, relation_kind, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(kind), sqlc.arg(from_line_id), sqlc.narg(from_message_id), sqlc.arg(to_line_id),
        sqlc.narg(to_message_id), sqlc.arg(label), sqlc.arg(relation_kind), sqlc.arg(created_by))
RETURNING *;

-- name: ListLinksOfLines :many
-- Links of the kinds from or to any of the lines, newest first, with the
-- line each end is on now (a message end follows its message) and those
-- lines' titles.
SELECT sqlc.embed(k), fl.id AS from_at, fl.title AS from_title, tl.id AS to_at, tl.title AS to_title
FROM tangent_link k
LEFT JOIN tangent_message fm ON fm.id = k.from_message_id
LEFT JOIN tangent_message tm ON tm.id = k.to_message_id
JOIN tangent_line fl ON fl.id = coalesce(fm.line_id, k.from_line_id)
JOIN tangent_line tl ON tl.id = coalesce(tm.line_id, k.to_line_id)
WHERE k.tenant_id = sqlc.arg(tenant_id) AND k.kind = ANY(sqlc.arg(kinds)::text[])
  AND (k.from_line_id = ANY(sqlc.arg(line_ids)::uuid[]) OR k.to_line_id = ANY(sqlc.arg(line_ids)::uuid[]))
ORDER BY k.created_at DESC, k.id
LIMIT sqlc.arg(row_limit);

-- name: GetLinkView :one
SELECT sqlc.embed(k), fl.id AS from_at, fl.title AS from_title, tl.id AS to_at, tl.title AS to_title
FROM tangent_link k
LEFT JOIN tangent_message fm ON fm.id = k.from_message_id
LEFT JOIN tangent_message tm ON tm.id = k.to_message_id
JOIN tangent_line fl ON fl.id = coalesce(fm.line_id, k.from_line_id)
JOIN tangent_line tl ON tl.id = coalesce(tm.line_id, k.to_line_id)
WHERE k.id = $1;
