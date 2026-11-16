-- Lines and their messages. A line without a tangent_branch row is a main
-- line (the root of a tree). Messages are ordered by their global seq, never
-- by created_at: moving a message to another line keeps its seq, so a move or
-- a promotion never renumbers anything.

CREATE TABLE tangent_line (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','thinking','error')),
    status_detail TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    unread INT NOT NULL DEFAULT 0,
    -- The rolling summary and the seq of the newest message it covers.
    summary JSONB,
    summary_upto_seq BIGINT,
    -- notes_revision is meaningful on a main line; notes_revision_sent is the
    -- revision the line's last finished turn carried.
    notes_revision INT NOT NULL DEFAULT 0,
    notes_revision_sent INT NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    host_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tangent_line_tenant ON tangent_line (tenant_id, archived_at, last_activity_at DESC, id DESC);

CREATE TABLE tangent_message (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seq BIGINT NOT NULL GENERATED ALWAYS AS IDENTITY UNIQUE,
    line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat','branch_card','branch_marker')),
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done','error')),
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    host_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_tangent_message_line ON tangent_message (line_id, seq);
-- The stale-turn sweep reads pending messages by age.
CREATE INDEX idx_tangent_message_pending ON tangent_message (created_at) WHERE status = 'pending';
