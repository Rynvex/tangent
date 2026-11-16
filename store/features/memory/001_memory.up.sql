-- Memory (feature "memory", B10 part C): what a tenant's conversations
-- settled, kept across conversations. A memory is never deleted: it is
-- superseded (status superseded, superseded_by the one that replaced it).
-- The sources have no foreign keys: a memory outlives the conversation it
-- came from (source_label keeps a text of it). embedding is a pgvector
-- vector of the host's Embedder (embedding_dim records its size; recall
-- compares only memories of the same size, so a host may change models).
-- The vector extension is installed by store.MigrateFeatures before this
-- file runs.
CREATE TABLE tangent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','lesson')),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
    superseded_by UUID REFERENCES tangent_memory(id),
    importance INT NOT NULL CHECK (importance BETWEEN 1 AND 10),
    valid_until TIMESTAMPTZ,
    source_line_id UUID,
    source_message_id UUID,
    source_leaf_line_id UUID,
    source_note_id UUID,
    source_label TEXT NOT NULL DEFAULT '',
    source_job_id UUID,
    embedding vector,
    embedding_dim INT NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status = 'superseded') = (superseded_by IS NOT NULL))
);
CREATE INDEX idx_tangent_memory_tenant ON tangent_memory (tenant_id, created_at DESC);
CREATE INDEX idx_tangent_memory_active ON tangent_memory (tenant_id, embedding_dim) WHERE status = 'active';
