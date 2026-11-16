-- B8.1: a seed's source label, the text snapshot of where it was parked
-- (the same rules as a note's), written with the seed.
ALTER TABLE tangent_seed ADD COLUMN source_label TEXT NOT NULL DEFAULT '';
