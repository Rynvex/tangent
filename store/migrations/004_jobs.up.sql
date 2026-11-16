-- Background jobs: one-shot AI work (conclusion card drafts, rolling
-- summaries, the jobs of feature modules). The host runs them; the store uses
-- the row for idempotency, supersession and timeouts.

CREATE TABLE tangent_job (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    feature TEXT NOT NULL DEFAULT 'core',
    line_id UUID REFERENCES tangent_line(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','superseded')),
    -- The cursors at the start of the job, so a late result can be judged stale.
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX idx_tangent_job_line ON tangent_job (line_id, kind, status);
