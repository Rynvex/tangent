DROP TABLE IF EXISTS tangent_link;
ALTER TABLE tangent_note DROP COLUMN IF EXISTS copied_from_note_id;
ALTER TABLE tangent_line DROP COLUMN IF EXISTS origin_capsule;
