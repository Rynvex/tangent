ALTER TABLE tangent_note DROP COLUMN IF EXISTS source_label;

UPDATE tangent_branch SET origin = 'button' WHERE origin = 'seed';
ALTER TABLE tangent_branch DROP CONSTRAINT IF EXISTS tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line'));

DROP TABLE IF EXISTS tangent_seed;
DROP TABLE IF EXISTS tangent_leaf;
DROP TABLE IF EXISTS tangent_suggestion;
