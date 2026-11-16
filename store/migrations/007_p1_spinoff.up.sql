-- P1 (B8), part B: spinning conversations off. A spun-off main line keeps
-- its origin capsule (the fixed block its prompts start with); links join
-- the two places (relations, B9, share the table).

ALTER TABLE tangent_line ADD COLUMN origin_capsule JSONB;

-- A note copied into a spun-off conversation points at the note it copies
-- (no foreign key: the source conversation may be deleted).
ALTER TABLE tangent_note ADD COLUMN copied_from_note_id UUID;

CREATE TABLE tangent_link (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spinoff','relation')),
    from_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    from_message_id UUID,
    to_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    to_message_id UUID,
    label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_tangent_link_from ON tangent_link (from_line_id);
CREATE INDEX idx_tangent_link_to ON tangent_link (to_line_id);
