-- The extension stays: other objects of the database may use it.
DROP INDEX IF EXISTS idx_tangent_message_search_recent;
DROP INDEX IF EXISTS idx_tangent_message_content_trgm;
DROP INDEX IF EXISTS idx_tangent_branch_purpose_trgm;
DROP INDEX IF EXISTS idx_tangent_line_title_trgm;
