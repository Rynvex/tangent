-- B18: organising main lines. A folder groups conversations in the list
-- ('' = unfiled) and tags label their topics; both belong to main lines
-- only (a branch keeps '' and '{}'). Both columns have constant defaults,
-- so adding them rewrites no rows. Branches written by an import have their
-- own origin.
ALTER TABLE tangent_line
    ADD COLUMN folder TEXT NOT NULL DEFAULT '',
    ADD COLUMN tags   TEXT[] NOT NULL DEFAULT '{}';

-- GET /lines?folder= and POST /lines/folders/rename look a tenant's folder up.
CREATE INDEX idx_tangent_line_folder ON tangent_line (tenant_id, folder) WHERE folder <> '';
-- GET /lines?tag= and the related lines of GET /lines/{id}/decompose.
CREATE INDEX idx_tangent_line_tags ON tangent_line USING gin (tags);

ALTER TABLE tangent_branch DROP CONSTRAINT tangent_branch_origin_check;
ALTER TABLE tangent_branch ADD CONSTRAINT tangent_branch_origin_check
    CHECK (origin IN ('selection','button','move','suggestion','previous_main_line','seed','merge','diverge','import'));
