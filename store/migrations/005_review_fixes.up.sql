-- Review fixes for S2: indexes for foreign keys and hot reads, a last line of
-- defence for the single pending turn, branch state constraints, and the
-- draft job id as a UUID like tangent_job.id.

-- One in-flight assistant turn per line, whatever the code above does.
CREATE UNIQUE INDEX idx_tangent_message_one_pending ON tangent_message (line_id)
    WHERE status = 'pending' AND role = 'assistant';
-- Undelivered conclusion cards of a line, by seq.
CREATE INDEX idx_tangent_message_cards ON tangent_message (line_id, seq) WHERE kind = 'branch_card';

-- Foreign keys that are deleted through (DeleteTree, aside purge).
CREATE INDEX idx_tangent_note_superseded_by ON tangent_note (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX idx_tangent_chapter_cut_line ON tangent_chapter_cut (line_id);

-- The main-line list, one index per archived state (ListMainLines uses
-- literal predicates so the planner can pick them).
DROP INDEX IF EXISTS idx_tangent_line_tenant;
CREATE INDEX idx_tangent_line_active ON tangent_line (tenant_id, last_activity_at DESC, id DESC) WHERE archived_at IS NULL;
CREATE INDEX idx_tangent_line_archived ON tangent_line (tenant_id, last_activity_at DESC, id DESC) WHERE archived_at IS NOT NULL;

-- The stale-job sweep reads pending jobs by kind and age.
CREATE INDEX idx_tangent_job_pending ON tangent_job (kind, created_at) WHERE status = 'pending';

ALTER TABLE tangent_branch
    ADD CONSTRAINT tangent_branch_closed_at_check CHECK ((status = 'open') = (closed_at IS NULL)),
    ADD CONSTRAINT tangent_branch_not_own_parent_check CHECK (parent_line_id <> line_id);

ALTER TABLE tangent_branch ALTER COLUMN draft_job_id DROP DEFAULT;
ALTER TABLE tangent_branch ALTER COLUMN draft_job_id DROP NOT NULL;
ALTER TABLE tangent_branch ALTER COLUMN draft_job_id TYPE UUID USING NULLIF(draft_job_id, '')::uuid;
