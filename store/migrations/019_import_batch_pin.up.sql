-- Tangent 019: import batches and pinned conversations (B25).
-- An import batch is one "import these files" action of a client: the
-- client picks its id and sends it with every POST /lines/import of the
-- batch, so the batch can be listed and undone later (GET /imports, DELETE
-- /imports/{id}) instead of only within the browser session.
CREATE TABLE tangent_import_batch (
    id UUID PRIMARY KEY,                 -- chosen by the client
    tenant_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',      -- for example the file name
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tangent_import_batch_tenant ON tangent_import_batch (tenant_id, created_at DESC, id DESC);

-- The batch a main line was imported in. No foreign key: the line outlives
-- the batch row. import_seq and import_activity_at are the tree as the
-- import left it (its newest message seq, the main line's activity time),
-- so undoing the batch can tell a conversation that was used since (B19
-- dates make last_activity_at the source's, not the import's). pinned_at:
-- the operator pinned the conversation (main lines only).
-- Plain nullable columns: no default, existing rows are not rewritten.
ALTER TABLE tangent_line
    ADD COLUMN import_batch_id UUID,
    ADD COLUMN import_seq BIGINT,
    ADD COLUMN import_activity_at TIMESTAMPTZ,
    ADD COLUMN pinned_at TIMESTAMPTZ;
CREATE INDEX tangent_line_import_batch ON tangent_line (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX tangent_line_pinned ON tangent_line (tenant_id, pinned_at DESC, id DESC) WHERE pinned_at IS NOT NULL;
