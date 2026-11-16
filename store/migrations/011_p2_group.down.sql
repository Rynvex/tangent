UPDATE tangent_branch SET origin = 'button' WHERE origin = 'merge';
ALTER TABLE tangent_branch DROP CONSTRAINT IF EXISTS tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed'));
ALTER TABLE tangent_branch DROP COLUMN IF EXISTS merged_into_line_id;
DROP TABLE IF EXISTS tangent_group_member;
DROP TABLE IF EXISTS tangent_group;
