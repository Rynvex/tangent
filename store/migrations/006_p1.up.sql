-- P1 (B8), part A: the suggestion inbox, branch leaves, parked thoughts
-- (seeds) and the source label of notes. These are core tables: a feature
-- that is off leaves them empty, so turning it on needs no migration.

-- What features in suggest mode propose. One target (feature, kind,
-- target_key) has at most one open suggestion per conversation; dismissed
-- rows are kept for the cooldown. line_id is the line the suggestion is
-- about: when that branch ends, its open suggestions expire.
CREATE TABLE tangent_suggestion (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_key TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed','expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    decided_at TIMESTAMPTZ,
    CONSTRAINT tangent_suggestion_decided_check CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX idx_tangent_suggestion_one_open ON tangent_suggestion (root_line_id, feature, kind, target_key) WHERE status = 'open';
CREATE INDEX idx_tangent_suggestion_dismissed ON tangent_suggestion (root_line_id, feature, kind, target_key, decided_at DESC) WHERE status = 'dismissed';
CREATE INDEX idx_tangent_suggestion_root ON tangent_suggestion (root_line_id, created_at DESC);
CREATE INDEX idx_tangent_suggestion_line_open ON tangent_suggestion (line_id) WHERE status = 'open';

-- The closing note of a branch (one per branch line). source_job_id is the
-- leaf_draft job that wrote it while the operator has not rewritten it.
CREATE TABLE tangent_leaf (
    line_id UUID PRIMARY KEY REFERENCES tangent_line(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('conclusion','decision','answer','dead_end','to_continue')),
    line TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('draft','confirmed')),
    source_job_id UUID,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_tangent_leaf_root ON tangent_leaf (root_line_id);

-- Parked thoughts of a conversation. The anchor carries no foreign key:
-- messages move between lines and asides are purged.
CREATE TABLE tangent_seed (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    anchor_message_id UUID,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','expanded','noted','dropped')),
    expanded_line_id UUID REFERENCES tangent_line(id) ON DELETE SET NULL,
    note_id UUID REFERENCES tangent_note(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_tangent_seed_root ON tangent_seed (root_line_id, created_at DESC);
CREATE INDEX idx_tangent_seed_open ON tangent_seed (root_line_id) WHERE status = 'open';
CREATE INDEX idx_tangent_seed_expanded ON tangent_seed (expanded_line_id) WHERE expanded_line_id IS NOT NULL;
CREATE INDEX idx_tangent_seed_note ON tangent_seed (note_id) WHERE note_id IS NOT NULL;

-- A branch opened by expanding a seed.
ALTER TABLE tangent_branch DROP CONSTRAINT tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed'));

-- The text snapshot of a note's source, so it still reads once the source
-- line is gone. Notes written before this have ''.
ALTER TABLE tangent_note ADD COLUMN source_label TEXT NOT NULL DEFAULT '';
