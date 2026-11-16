-- Tangent 018: the glossary (B24, the glossary feature).
-- One list of "term -> explanation" per conversation (gone with it). A term
-- names the line and message it was saved from; when that line goes (a
-- deleted branch, a purged aside) the term stays with its source label.
-- term_key is the normalised term (domain.NormalizeTermKey), unique in the
-- conversation. The length limits are Limits.Glossary (a host may change
-- them), so the checks here are only "not empty".
CREATE TABLE tangent_term (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    term TEXT NOT NULL CHECK (term <> ''),
    term_key TEXT NOT NULL CHECK (term_key <> ''),
    explanation TEXT NOT NULL CHECK (explanation <> ''),
    source_line_id UUID REFERENCES tangent_line(id) ON DELETE SET NULL,
    source_message_id UUID,  -- no foreign key: messages move between lines
    source_label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (root_line_id, term_key)
);
CREATE INDEX tangent_term_tenant_key ON tangent_term (tenant_id, term_key);
