ALTER TABLE tangent_branch ALTER COLUMN draft_job_id TYPE TEXT USING COALESCE(draft_job_id::text, '');
ALTER TABLE tangent_branch ALTER COLUMN draft_job_id SET DEFAULT '';
ALTER TABLE tangent_branch ALTER COLUMN draft_job_id SET NOT NULL;

ALTER TABLE tangent_branch
    DROP CONSTRAINT IF EXISTS tangent_branch_not_own_parent_check,
    DROP CONSTRAINT IF EXISTS tangent_branch_closed_at_check;

DROP INDEX IF EXISTS idx_tangent_job_pending;
DROP INDEX IF EXISTS idx_tangent_line_archived;
DROP INDEX IF EXISTS idx_tangent_line_active;
CREATE INDEX idx_tangent_line_tenant ON tangent_line (tenant_id, archived_at, last_activity_at DESC, id DESC);
DROP INDEX IF EXISTS idx_tangent_chapter_cut_line;
DROP INDEX IF EXISTS idx_tangent_note_superseded_by;
DROP INDEX IF EXISTS idx_tangent_message_cards;
DROP INDEX IF EXISTS idx_tangent_message_one_pending;
