-- The notes page of a conversation and the stored chapter cuts. Both belong
-- to the main line (root_line_id). Message and line references carry no
-- foreign key: messages move between lines, and ids are only references.

CREATE TABLE tangent_note (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    section TEXT NOT NULL CHECK (section IN ('decided','fact','to_confirm','todo')),
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','superseded')),
    source_line_id UUID,
    source_message_id UUID,
    source_card_message_id UUID,
    superseded_by UUID REFERENCES tangent_note(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL DEFAULT '',
    -- clock_timestamp so notes written in one transaction keep their order.
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tangent_note_root ON tangent_note (root_line_id, created_at DESC);

-- Idle gaps are computed on read; a topic cut is recorded by each rolling
-- summary and a milestone is marked by an operator. A cut whose message left
-- the line is ignored when the chapters are read.
CREATE TABLE tangent_chapter_cut (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    message_id UUID NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('topic','milestone')),
    title TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX idx_tangent_chapter_cut_message_kind ON tangent_chapter_cut (message_id, kind);
CREATE INDEX idx_tangent_chapter_cut_root ON tangent_chapter_cut (root_line_id, created_at DESC);
