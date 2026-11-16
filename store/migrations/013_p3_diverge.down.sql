DROP TABLE IF EXISTS tangent_comparison;
UPDATE tangent_branch SET origin = 'button' WHERE origin = 'diverge';
ALTER TABLE tangent_branch DROP CONSTRAINT IF EXISTS tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed','merge'));
