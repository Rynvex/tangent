-- Search (feature "search"): trigram GIN indexes for ILIKE '%…%' over main-line
-- titles, branch purposes and finished chat messages. Chinese has no word
-- breaks, so trigrams of characters stand in for words. The pg_trgm
-- extension is installed by store.MigrateFeatures before this file runs.

CREATE INDEX idx_tangent_line_title_trgm ON tangent_line USING gin (title gin_trgm_ops);
CREATE INDEX idx_tangent_branch_purpose_trgm ON tangent_branch USING gin (purpose gin_trgm_ops);
-- Only what search reads: finished operator and assistant chat messages.
CREATE INDEX idx_tangent_message_content_trgm ON tangent_message USING gin (content gin_trgm_ops)
    WHERE status = 'done' AND kind = 'chat' AND role IN ('user', 'assistant');
-- Newest searchable messages of a tenant first: a query too short for
-- trigrams (two characters) walks this and stops at the candidate cap.
CREATE INDEX idx_tangent_message_search_recent ON tangent_message (tenant_id, seq DESC)
    WHERE status = 'done' AND kind = 'chat' AND role IN ('user', 'assistant');
