-- B15: a relation's kind. Relations were labels only, so whether one marks
-- a contradiction could only be guessed from its text; the kind says it.
-- Spinoff links keep the default and never show it.
ALTER TABLE tangent_link
    ADD COLUMN relation_kind TEXT NOT NULL DEFAULT 'related'
    CHECK (relation_kind IN ('related', 'supports', 'contradicts', 'depends_on'));
