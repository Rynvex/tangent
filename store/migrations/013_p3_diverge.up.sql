-- P3 (B10), part B: diverging into sibling branches and comparing them.

ALTER TABLE tangent_branch DROP CONSTRAINT tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed','merge','diverge'));

-- A comparison of sibling branches of one parent (converge): status follows
-- its converge job (source_job_id); matrix is criteria × options with a
-- recommendation once ready; deciding records the chosen branch.
CREATE TABLE tangent_comparison (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    parent_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    line_ids UUID[] NOT NULL,
    criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting','ready','failed','decided')),
    matrix JSONB,
    decided_line_id UUID REFERENCES tangent_line(id) ON DELETE SET NULL,
    source_job_id UUID,
    created_by TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    decided_at TIMESTAMPTZ
);
CREATE INDEX idx_tangent_comparison_parent ON tangent_comparison (parent_line_id, created_at DESC);
CREATE INDEX idx_tangent_comparison_job ON tangent_comparison (source_job_id) WHERE source_job_id IS NOT NULL;
