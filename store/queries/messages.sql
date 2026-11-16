-- Messages. Order within a line is always by seq.

-- name: InsertMessage :one
INSERT INTO tangent_message (line_id, tenant_id, role, kind, content, status, meta, host_meta)
VALUES (sqlc.arg(line_id), sqlc.arg(tenant_id), sqlc.arg(role), sqlc.arg(kind), sqlc.arg(content), sqlc.arg(status), sqlc.arg(meta), sqlc.arg(host_meta))
RETURNING *;

-- name: GetMessage :one
SELECT * FROM tangent_message WHERE id = $1;

-- name: ListMessagesAfterSeq :many
-- Ascending transcript page after a seq cursor.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq > sqlc.arg(after_seq)::bigint
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: ListRecentMessages :many
-- The newest messages, newest first; callers reverse them.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id)
ORDER BY seq DESC
LIMIT sqlc.arg(row_limit);

-- name: CountPendingMessages :one
SELECT count(*)::int FROM tangent_message WHERE line_id = $1 AND status = 'pending';

-- name: GetPendingAssistantMessage :one
-- The one in-flight assistant message of a line.
SELECT * FROM tangent_message
WHERE line_id = $1 AND role = 'assistant' AND status = 'pending'
ORDER BY seq DESC
LIMIT 1;

-- name: CompletePendingMessage :one
-- Finishes a pending message; matches nothing once it is no longer pending.
-- Only the top-level keys of the patch change in meta.
UPDATE tangent_message
SET content = sqlc.arg(content), status = sqlc.arg(status), meta = meta || sqlc.arg(meta_patch)::jsonb
WHERE id = sqlc.arg(id) AND status = 'pending'
RETURNING *;

-- name: ListDoneMessagesUpToSeq :many
-- Finished messages at or before a seq, newest first (the branch pack).
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq <= sqlc.arg(upto_seq)::bigint AND status = 'done'
ORDER BY seq DESC
LIMIT sqlc.arg(row_limit);

-- name: ListDoneMessagesAfterSeq :many
-- Finished messages after a seq, newest first (the "later developments").
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq > sqlc.arg(after_seq)::bigint AND status = 'done'
ORDER BY seq DESC
LIMIT sqlc.arg(row_limit);

-- name: ListRelevantMessagesAfterSeq :many
-- Finished operator, assistant and card messages after a seq, oldest first.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq > sqlc.arg(after_seq)::bigint AND status = 'done'
  AND (role <> 'system' OR kind = 'branch_card')
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: LatestRelevantMessage :one
-- The newest message that counts for "the conversation moved on".
SELECT * FROM tangent_message
WHERE line_id = $1 AND status = 'done' AND (role <> 'system' OR kind = 'branch_card')
ORDER BY seq DESC
LIMIT 1;

-- name: HasConversationMessage :one
-- Whether a line holds a finished operator or assistant message.
SELECT EXISTS (
    SELECT 1 FROM tangent_message
    WHERE line_id = $1 AND status = 'done' AND role IN ('user', 'assistant')
)::boolean;

-- name: CountDoneAssistantReplies :one
-- Finished assistant replies of a line: an aside takes only one. A
-- cancelled reply is not an answer.
SELECT count(*)::int FROM tangent_message
WHERE line_id = $1 AND role = 'assistant' AND status = 'done'
  AND COALESCE(meta->>'cancelled', 'false') <> 'true';

-- name: ListUndeliveredCards :many
-- Conclusion cards of a line no turn has carried yet, oldest first.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND kind = 'branch_card' AND status = 'done'
  AND COALESCE(meta->>'delivered', 'false') <> 'true'
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: MarkCardsDelivered :many
-- Only conclusion cards of the named line that were not delivered yet
-- qualify, whatever ids are passed in; returns the cards it marked.
UPDATE tangent_message
SET meta = jsonb_set(meta, '{delivered}', 'true'::jsonb)
WHERE line_id = sqlc.arg(line_id) AND id = ANY(sqlc.arg(message_ids)::uuid[]) AND kind = 'branch_card'
  AND COALESCE(meta->>'delivered', 'false') <> 'true'
RETURNING *;

-- name: ListUnsummarizedMessages :many
-- Finished messages after the summary cursor, oldest first.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND status <> 'pending' AND seq > sqlc.arg(after_seq)::bigint
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: ListStalePendingMessages :many
-- Pending turns older than the cutoff, oldest first.
SELECT id, line_id FROM tangent_message
WHERE status = 'pending' AND created_at < sqlc.arg(cutoff)
ORDER BY created_at
LIMIT sqlc.arg(row_limit);

-- name: MoveMessagesByIDs :execrows
UPDATE tangent_message SET line_id = sqlc.arg(to_line)
WHERE line_id = sqlc.arg(from_line) AND id = ANY(sqlc.arg(ids)::uuid[]);

-- name: MoveMessagesAfterSeq :execrows
-- Every message of the line after a seq (the tail after a fork point).
UPDATE tangent_message SET line_id = sqlc.arg(to_line)
WHERE line_id = sqlc.arg(from_line) AND seq > sqlc.arg(after_seq)::bigint;

-- name: MoveAllMessages :execrows
UPDATE tangent_message SET line_id = sqlc.arg(to_line) WHERE line_id = sqlc.arg(from_line);

-- name: ListChapterMessages :many
-- The finished messages of one line in order, without their bodies.
SELECT id, seq, created_at, kind FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND status = 'done'
ORDER BY seq
LIMIT sqlc.arg(row_limit);

-- name: ListMessageHostMeta :many
-- The host data of the messages of a set of lines (only non-empty objects).
SELECT id, line_id, host_meta FROM tangent_message
WHERE line_id = ANY(sqlc.arg(line_ids)::uuid[]) AND host_meta <> '{}'::jsonb
ORDER BY seq;

-- name: GetLineMessageBySeq :one
SELECT * FROM tangent_message WHERE line_id = sqlc.arg(line_id) AND seq = sqlc.arg(seq)::bigint;

-- name: SetFinishedMessageUsage :one
-- Records usage on a finished assistant message that has none yet; matches
-- nothing for a pending message or one whose usage is already recorded.
UPDATE tangent_message
SET meta = meta || jsonb_build_object('usage', sqlc.arg(usage)::jsonb)
WHERE id = sqlc.arg(id) AND role = 'assistant' AND status <> 'pending' AND NOT (meta ? 'usage')
RETURNING *;

-- name: GetUnsummarizedSize :one
-- How many finished messages follow the summary cursor, up to the first
-- conclusion card no turn has carried, and their total length in characters.
SELECT count(*)::bigint AS messages, coalesce(sum(char_length(m.content)), 0)::bigint AS chars
FROM tangent_message m
WHERE m.line_id = sqlc.arg(line_id) AND m.status <> 'pending' AND m.seq > sqlc.arg(after_seq)::bigint
  AND m.seq < coalesce((
    SELECT min(c.seq) FROM tangent_message c
    WHERE c.line_id = sqlc.arg(line_id) AND c.kind = 'branch_card' AND NOT coalesce((c.meta->>'delivered')::boolean, false)
  ), 9223372036854775807);

-- name: SavePendingPartial :execrows
-- Keeps the text streamed so far on a pending reply, with the delta seq it
-- covers; matches nothing once the reply is finished or when a later
-- partial was already saved.
UPDATE tangent_message
SET content = sqlc.arg(content), meta = meta || jsonb_build_object('streamSeq', sqlc.arg(stream_seq)::bigint)
WHERE id = sqlc.arg(id) AND status = 'pending'
  AND COALESCE((meta->>'streamSeq')::bigint, 0) < sqlc.arg(stream_seq)::bigint;

-- name: CountChatMessagesUpTo :one
-- The place of a message among its line's chat messages (the client's "#n").
SELECT count(*)::int FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq <= sqlc.arg(seq) AND kind = 'chat' AND role IN ('user','assistant');

-- name: LatestChatMessage :one
-- The newest finished operator or assistant message of a line (a branch may hang on it).
SELECT * FROM tangent_message
WHERE line_id = $1 AND status = 'done' AND kind = 'chat' AND role IN ('user','assistant')
ORDER BY seq DESC LIMIT 1;

-- name: SetMessagePinned :one
UPDATE tangent_message SET pinned = sqlc.arg(pinned) WHERE id = sqlc.arg(id) RETURNING *;

-- name: GetTurnOperatorMessage :one
-- The operator message a pending reply answers: the newest user message
-- before it (a retried turn has its failed reply in between).
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND role = 'user' AND seq < sqlc.arg(before_seq)::bigint
ORDER BY seq DESC
LIMIT 1;

-- name: ListLineMessagesByIDs :many
-- The named messages of one line, in seq order.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND id = ANY(sqlc.arg(ids)::uuid[])
ORDER BY seq;

-- name: LatestHostSystemContent :one
-- The content of the newest host system message (role system, kind chat)
-- among the line's newest row_limit messages.
SELECT m.content FROM (
    SELECT seq, role, kind, content FROM tangent_message
    WHERE line_id = sqlc.arg(line_id)
    ORDER BY seq DESC
    LIMIT sqlc.arg(row_limit)
) m
WHERE m.role = 'system' AND m.kind = 'chat'
ORDER BY m.seq DESC
LIMIT 1;

-- name: ListRecentTurnMessages :many
-- The newest messages that are not host system messages (role system, kind
-- chat), newest first; callers reverse them.
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND NOT (role = 'system' AND kind = 'chat')
ORDER BY seq DESC
LIMIT sqlc.arg(row_limit);

-- name: ListTreeMessages :many
-- The oldest per_line messages of each of the lines (an export, B14), in
-- line then seq order; callers ask for one more than they keep to see a
-- line that has more.
SELECT * FROM tangent_message
WHERE id IN (
    SELECT n.id FROM (
        SELECT m.id, row_number() OVER (PARTITION BY m.line_id ORDER BY m.seq) AS position
        FROM tangent_message m WHERE m.tenant_id = sqlc.arg(tenant_id) AND m.line_id = ANY(sqlc.arg(line_ids)::uuid[])
    ) n WHERE n.position <= sqlc.arg(per_line)::bigint
)
ORDER BY line_id, seq;

-- name: UpdateCardMessage :one
-- Rewrites an edited conclusion card (B17): the content and meta.card
-- change, editedAt is the database clock in UTC (B17.1), the other meta keys
-- stay and delivered goes, so the next turn of the line carries the card
-- again.
UPDATE tangent_message
SET content = sqlc.arg(content),
    meta = (meta || jsonb_build_object(
        'card', sqlc.arg(card)::jsonb,
        'editedAt', to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    )) - 'delivered'
WHERE id = sqlc.arg(id) AND kind = 'branch_card' AND status = 'done'
RETURNING *;

-- name: ListMessagesBeforeSeq :many
-- The newest messages of a line before a seq, newest first (B18: what
-- stays before an extracted range).
SELECT * FROM tangent_message
WHERE line_id = sqlc.arg(line_id) AND seq < sqlc.arg(before_seq)::bigint
ORDER BY seq DESC
LIMIT sqlc.arg(row_limit);

-- name: CountMessagesAfterSeq :one
SELECT count(*)::int FROM tangent_message WHERE line_id = sqlc.arg(line_id) AND seq > sqlc.arg(after_seq)::bigint;

-- name: RenumberMessage :one
-- Gives a message a fresh seq (the newest), so its old one can hold the
-- message an extract leaves in its place (B18).
UPDATE tangent_message SET seq = DEFAULT WHERE id = sqlc.arg(id) RETURNING seq;

-- name: InsertMessageAtSeq :one
-- InsertMessage at a given (vacated) seq and time: the marker or card an
-- extract leaves where the range was, dated like the message it replaces.
INSERT INTO tangent_message (seq, line_id, tenant_id, role, kind, content, status, meta, host_meta, created_at)
OVERRIDING SYSTEM VALUE
VALUES (sqlc.arg(seq), sqlc.arg(line_id), sqlc.arg(tenant_id), sqlc.arg(role), sqlc.arg(kind), sqlc.arg(content), sqlc.arg(status), sqlc.arg(meta), sqlc.arg(host_meta),
    sqlc.arg(created_at))
RETURNING *;

-- name: InsertMessageAt :one
-- InsertMessage at a given time: an imported message dated by its source,
-- or the conclusion card an import leaves after its anchor (B19).
INSERT INTO tangent_message (line_id, tenant_id, role, kind, content, status, meta, host_meta, created_at)
VALUES (sqlc.arg(line_id), sqlc.arg(tenant_id), sqlc.arg(role), sqlc.arg(kind), sqlc.arg(content), sqlc.arg(status), sqlc.arg(meta), sqlc.arg(host_meta),
    sqlc.arg(created_at))
RETURNING *;

-- name: MoveDoneMessages :many
-- Moves every finished message of a line to another line; seq does not
-- change (B23: the messages of a continued aside). Failed ones stay.
UPDATE tangent_message SET line_id = sqlc.arg(to_line)
WHERE line_id = sqlc.arg(from_line) AND status = 'done'
RETURNING id, seq;
