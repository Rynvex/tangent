-- B13: memos, notes on a node that never go to the AI (the memo feature).
-- A memo belongs to its conversation (gone with it) and names the node it
-- was written on; when that line goes (a deleted subtree), the memo stays
-- with its source label.
CREATE TABLE tangent_memo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    root_line_id UUID NOT NULL REFERENCES tangent_line(id) ON DELETE CASCADE,
    line_id UUID REFERENCES tangent_line(id) ON DELETE SET NULL,
    source_label TEXT NOT NULL,
    text TEXT NOT NULL CHECK (text <> ''),  -- the length limit is Limits.Memo (a host may change it)
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tangent_memo_root_idx ON tangent_memo (root_line_id, created_at);
