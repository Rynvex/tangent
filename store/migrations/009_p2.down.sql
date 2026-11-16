DROP INDEX IF EXISTS idx_tangent_suggestion_open_tenant;
DROP INDEX IF EXISTS idx_tangent_seed_open_tenant;
DROP INDEX IF EXISTS idx_tangent_note_to_confirm;
DROP INDEX IF EXISTS idx_tangent_branch_open_tenant;
ALTER TABLE tangent_message DROP COLUMN IF EXISTS pinned;
DROP TABLE IF EXISTS tangent_goal;
