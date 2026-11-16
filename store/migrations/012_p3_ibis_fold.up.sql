-- P3 (B10), part A: argument tags (ibis) and folds (fold).

-- A message's IBIS argument tag. source ai is a cheap model's (status
-- draft until the operator confirms it in suggest mode, confirmed in auto);
-- source user is the operator's and is never overwritten by a model. The
-- tag follows its message (moves keep the id); it goes with the message.
CREATE TABLE tangent_message_tag (
    message_id UUID PRIMARY KEY REFERENCES tangent_message(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('question','idea','pro','con','decision')),
    source TEXT NOT NULL CHECK (source IN ('ai','user')),
    status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','confirmed')),
    source_job_id UUID,
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- A folded stretch of a line: in later prompts its messages (from_seq ..
-- to_seq of the line) stand as the summary. The end messages have no
-- foreign key (messages move between lines; a fold whose ends left the line
-- does not apply). Drafting and active folds of one line never overlap
-- (checked under the line's lock).
CREATE TABLE tangent_fold (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    from_message_id UUID NOT NULL,
    to_message_id UUID NOT NULL,
    from_seq BIGINT NOT NULL,
    to_seq BIGINT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    message_count INT NOT NULL DEFAULT 0,
    tokens_original INT NOT NULL DEFAULT 0,
    tokens_summary INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('drafting','active','failed','removed')),
    source_job_id UUID,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (from_seq <= to_seq)
);
CREATE INDEX idx_tangent_fold_line ON tangent_fold (line_id, from_seq) WHERE status IN ('drafting','active');
CREATE INDEX idx_tangent_fold_job ON tangent_fold (source_job_id) WHERE source_job_id IS NOT NULL;
