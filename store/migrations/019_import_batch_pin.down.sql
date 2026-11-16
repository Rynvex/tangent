DROP INDEX IF EXISTS tangent_line_pinned;
DROP INDEX IF EXISTS tangent_line_import_batch;
ALTER TABLE tangent_line
    DROP COLUMN IF EXISTS pinned_at,
    DROP COLUMN IF EXISTS import_activity_at,
    DROP COLUMN IF EXISTS import_seq,
    DROP COLUMN IF EXISTS import_batch_id;
DROP TABLE IF EXISTS tangent_import_batch;
