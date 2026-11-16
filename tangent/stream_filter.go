package tangent

import (
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/Rynvex/tangent/domain"
)

// Streamed text is filtered by line before it reaches clients: a line that
// starts with a protocol marker ([BRANCH-SUGGEST] and the others, plus the
// host's extra markers) is never emitted, even when the marker arrives split
// across deltas. Line breaks and trailing whitespace are held until text
// follows them, so a reply whose suggestion lines are removed streams the
// same text CompleteTurn stores (the reply filter drops those lines and
// trims the end). Text inside a line passes as soon as the line can no
// longer start with a marker.

// lineMode is what the filter knows about the current line.
type lineMode int

const (
	lineUndecided lineMode = iota // too short to tell; held
	linePassing                   // not a marker line; streamed as it comes
	lineDropping                  // a marker line; dropped up to its break
)

// lineFilter filters one turn's text. White space is Unicode white space,
// as domain.TrimReply trims it.
type lineFilter struct {
	markers []string
	mode    lineMode
	line    string // held start of an undecided line
	held    string // held trailing whitespace and line breaks
	started bool   // some text was emitted (leading white space is dropped)
}

// push takes a piece of streamed text and returns what may be emitted now.
func (f *lineFilter) push(text string) string {
	var out strings.Builder
	for text != "" {
		piece, rest, broke := strings.Cut(text, "\n")
		text = rest
		f.take(piece, &out)
		if broke {
			f.endLine(&out)
		}
	}
	return out.String()
}

// emit writes text after what is held, holding its own trailing
// whitespace, and dropping the white space before the first text: a
// reply's leading and trailing white space is never streamed, like the
// stored reply (domain.TrimReply).
func (f *lineFilter) emit(text string, out *strings.Builder) {
	combined := f.held + text
	if !f.started {
		combined = strings.TrimLeftFunc(combined, unicode.IsSpace)
	}
	body := strings.TrimRightFunc(combined, unicode.IsSpace)
	if body == "" {
		f.held = combined
		return
	}
	out.WriteString(body)
	f.held, f.started = combined[len(body):], true
}

// take handles text within the current line.
func (f *lineFilter) take(piece string, out *strings.Builder) {
	switch f.mode {
	case lineDropping:
		return
	case linePassing:
		f.emit(piece, out)
		return
	}
	f.line += piece
	f.decide(out)
}

// decide settles an undecided line once its start shows whether it is a
// marker line.
func (f *lineFilter) decide(out *strings.Builder) {
	start := domain.MarkerLineStart(f.line)
	if start == "" {
		return
	}
	for _, marker := range f.markers {
		if strings.HasPrefix(start, marker) {
			f.mode, f.line = lineDropping, ""
			return
		}
	}
	for _, marker := range f.markers {
		if strings.HasPrefix(marker, start) {
			return // could still become this marker
		}
	}
	f.mode = linePassing
	f.emit(f.line, out)
	f.line = ""
}

// endLine handles a line break: a marker line goes with its break; other
// breaks are held until text follows.
func (f *lineFilter) endLine(out *strings.Builder) {
	switch f.mode {
	case lineDropping:
	case linePassing:
		f.held += "\n"
	default:
		// A blank line, or a short one that never became a marker.
		f.emit(f.line, out)
		f.held += "\n"
	}
	f.mode, f.line = lineUndecided, ""
}

// flush returns the held start of the last line when the reply ends; held
// trailing whitespace is dropped.
func (f *lineFilter) flush() string {
	out := f.remainder()
	f.line, f.held = "", ""
	return out
}

// remainder is what flush would return, without ending the line.
func (f *lineFilter) remainder() string {
	if f.mode != lineUndecided {
		return ""
	}
	copied := *f
	var out strings.Builder
	copied.emit(f.line, &out)
	return out.String()
}

// Defaults of the partial-reply saves (WithPartialFlush).
const (
	DefaultPartialInterval = 2 * time.Second
	DefaultPartialBytes    = 8 << 10
)

// turnStream is one streaming turn: its line filter and the text it let
// through (up to partialTextMax), with the seq of the last delta and what
// was last saved on the pending message.
type turnStream struct {
	filter     lineFilter
	text       strings.Builder
	seq        int64
	full       bool
	savedLen   int
	savedAt    time.Time
	lastActive time.Time
}

// partialReply is a save of the text streamed so far.
type partialReply struct {
	content string
	seq     int64
}

// Tombstones of finished turns: a delta that raced the end of its turn
// (checked as pending, then the turn ended) must not open a new stream.
const (
	tombstoneTTL = time.Minute
	maxTombstone = 4096
)

// streamFilters keeps the stream of every turn running in this process,
// and a short-lived tombstone of every turn that finished.
type streamFilters struct {
	mu       sync.Mutex
	markers  []string
	interval time.Duration
	bytes    int
	turns    map[string]*turnStream
	finished map[string]time.Time
}

func newStreamFilters(markers []string, interval time.Duration, bytes int) *streamFilters {
	return &streamFilters{
		markers: markers, interval: interval, bytes: bytes, turns: map[string]*turnStream{}, finished: map[string]time.Time{},
	}
}

// push filters a text delta of a turn; a finished turn takes no more text.
func (s *streamFilters) push(turnID, text string, now time.Time) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dead := s.finished[turnID]; dead {
		return ""
	}
	t, ok := s.turns[turnID]
	if !ok {
		t = &turnStream{filter: lineFilter{markers: s.markers}, savedAt: now}
		s.turns[turnID] = t
	}
	t.lastActive = now
	return t.filter.push(text)
}

// emitted records text that was streamed as delta seq. It returns a
// partial reply to save when the unsaved text reached the size threshold
// or the last save is older than the interval; nothing once the text
// outgrew partialTextMax (the saved start stays).
func (s *streamFilters) emitted(turnID, text string, seq int64, now time.Time) (partialReply, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.turns[turnID]
	if !ok || t.full {
		return partialReply{}, false
	}
	if t.text.Len()+len(text) > partialTextMax {
		t.full = true
		return partialReply{}, false
	}
	t.text.WriteString(text)
	t.seq = seq
	if t.text.Len()-t.savedLen < s.bytes && now.Sub(t.savedAt) < s.interval {
		return partialReply{}, false
	}
	t.savedLen, t.savedAt = t.text.Len(), now
	return partialReply{content: t.text.String(), seq: seq}, true
}

// snapshot is the text a cancel keeps: what was streamed plus the held end
// of the last line when it is not a marker line.
func (s *streamFilters) snapshot(turnID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.turns[turnID]
	if !ok || t.full {
		return "", false
	}
	return t.text.String() + t.filter.remainder(), true
}

// finish ends a turn's stream, leaves its tombstone and returns its held
// remainder.
func (s *streamFilters) finish(turnID string, now time.Time) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bury(turnID, now)
	t, ok := s.turns[turnID]
	if !ok {
		return ""
	}
	delete(s.turns, turnID)
	return t.filter.flush()
}

// bury records a finished turn, keeping the tombstones bounded: expired
// ones go first, then any while there are too many.
func (s *streamFilters) bury(turnID string, now time.Time) {
	if len(s.finished) >= maxTombstone {
		for id, at := range s.finished {
			if now.Sub(at) > tombstoneTTL || len(s.finished) >= maxTombstone {
				delete(s.finished, id)
			}
		}
	}
	s.finished[turnID] = now
}

// sweep drops the streams of turns idle since before cutoff (turns another
// process completed).
func (s *streamFilters) sweep(cutoff time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, t := range s.turns {
		if t.lastActive.Before(cutoff) {
			delete(s.turns, id)
		}
	}
}

// sweepTombstones drops tombstones older than cutoff.
func (s *streamFilters) sweepTombstones(cutoff time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, at := range s.finished {
		if at.Before(cutoff) {
			delete(s.finished, id)
		}
	}
}
