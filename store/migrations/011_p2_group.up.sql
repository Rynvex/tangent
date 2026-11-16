-- P2 (B9), part C: groups of branches and combined branches.

-- A group circles branches of one tree with a shared summary that stands
-- for their leaves. summary_status follows its group_summary job
-- (source_job_id); settled are the claims the operator adopted when the
-- group was made from a suggestion (the summary follows them).
CREATE TABLE tangent_group (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    summary_status TEXT NOT NULL DEFAULT 'none' CHECK (summary_status IN ('none','drafting','ready','failed')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dissolved')),
    source_job_id UUID,
    settled JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_tangent_group_root ON tangent_group (root_line_id, created_at DESC);

CREATE TABLE tangent_group_member (
    group_id UUID NOT NULL REFERENCES tangent_group(id) ON DELETE CASCADE,
    line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, line_id)
);
CREATE INDEX idx_tangent_group_member_line ON tangent_group_member (line_id);

-- A branch combined into another is discarded and points at it.
ALTER TABLE tangent_branch ADD COLUMN merged_into_line_id UUID REFERENCES tangent_line(id) ON DELETE SET NULL;
ALTER TABLE tangent_branch DROP CONSTRAINT tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed','merge'));
