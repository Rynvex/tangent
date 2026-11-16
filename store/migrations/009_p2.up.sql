-- P2 (B9), part A: the conversation goal, pinned messages and the indexes
-- of the open-loops listing and of relations. Relations are rows of
-- tangent_link (kind relation, 007).

-- One goal per conversation (its main line). source: the operator wrote it
-- (manual) or it came from the model (ai).
CREATE TABLE tangent_goal (
    root_line_id UUID PRIMARY KEY REFERENCES tangent_line(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('manual','ai')),
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- A message the operator pinned (the fisheye context's head start).
ALTER TABLE tangent_message ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;

-- Open loops of a whole tenant: open branches, notes to confirm, open seeds
-- and open suggestions.
CREATE INDEX idx_tangent_branch_open_tenant ON tangent_branch (tenant_id) WHERE status = 'open';
CREATE INDEX idx_tangent_note_to_confirm ON tangent_note (tenant_id, created_at DESC) WHERE section = 'to_confirm' AND status = 'active';
CREATE INDEX idx_tangent_seed_open_tenant ON tangent_seed (tenant_id, created_at DESC) WHERE status = 'open';
CREATE INDEX idx_tangent_suggestion_open_tenant ON tangent_suggestion (tenant_id, created_at DESC) WHERE status = 'open';
