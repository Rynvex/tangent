-- Branches. A branch is an ordinary line plus one row here that hangs it on
-- a message of its parent. The anchor and the draft cursors carry no foreign
-- key: messages move between lines when a branch is moved or promoted.

CREATE TABLE tangent_branch (
    line_id UUID PRIMARY KEY REFERENCES tangent_line(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    parent_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    anchor_message_id UUID NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('aside','investigate','alternative')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','merged','discarded','promoted')),
    depth INT NOT NULL CHECK (depth >= 1),
    origin TEXT NOT NULL CHECK (origin IN ('selection','button','move','suggestion','previous_main_line')),
    -- The background pack: its structure and the exact text the model got.
    pack JSONB NOT NULL DEFAULT '{}'::jsonb,
    draft_status TEXT NOT NULL DEFAULT 'none' CHECK (draft_status IN ('none','drafting','ready','failed')),
    -- The neutralised draft outcome, never the model's raw output.
    draft JSONB NOT NULL DEFAULT '{}'::jsonb,
    draft_job_id TEXT NOT NULL DEFAULT '',
    draft_started_at TIMESTAMPTZ,
    draft_upto_seq BIGINT,
    draft_parent_tip_message_id UUID,
    conclusion_line TEXT NOT NULL DEFAULT '',
    card_message_id UUID,
    closed_at TIMESTAMPTZ,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tangent_branch_parent ON tangent_branch (parent_line_id, status);
CREATE INDEX idx_tangent_branch_root ON tangent_branch (root_line_id, created_at);
-- The aside purge reads ended asides by the time they ended.
CREATE INDEX idx_tangent_branch_aside_closed ON tangent_branch (closed_at) WHERE kind = 'aside' AND status <> 'open';
