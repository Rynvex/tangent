-- Tangent 017: keeping an aside (B23).
-- An answered aside ends and is purged after the retention; kept_at exempts
-- it from the purge without adding a branch state. A plain nullable column:
-- no default, so existing rows are not rewritten.

ALTER TABLE tangent_branch ADD COLUMN kept_at TIMESTAMPTZ;
