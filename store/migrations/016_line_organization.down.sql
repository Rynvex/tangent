UPDATE tangent_branch SET origin = 'button' WHERE origin = 'import';
ALTER TABLE tangent_branch DROP CONSTRAINT IF EXISTS tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed','merge','diverge'));
DROP INDEX IF EXISTS idx_tangent_line_tags;
DROP INDEX IF EXISTS idx_tangent_line_folder;
ALTER TABLE tangent_line DROP COLUMN IF EXISTS tags, DROP COLUMN IF EXISTS folder;
