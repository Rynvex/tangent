-- P2 (B9), part B: the fisheye context reads a line's pinned messages
-- (they may be older than the history it scans).
CREATE INDEX idx_tangent_message_pinned ON tangent_message (line_id, seq DESC) WHERE pinned;
