package tangent

import (
	"strings"
	"sync"
	"time"

	"github.com/Rynvex/tangent/domain"
)

// The delta buffer (in-memory session delta registry): the
// streamed pieces of a reply are held in a bounded in-memory tail per line so
// a client that reconnects can catch up with StreamSince. It is a cache, not
// the source of truth (the finished message in Postgres is), and it is lost
// on a restart. Buffers are reclaimed by age and by a per-tenant cap.
//
// Sequence numbers come from one process-wide counter that starts at the
// process's start time in microseconds, so they never restart for a line
// when its buffer is evicted, and a restarted process continues above the
// numbers it handed out before. Whatever a client cannot get any more is
// reported as truncated.

const (
	// deltaBufferLimit caps the bytes kept per line.
	deltaBufferLimit = 64 * 1024
	// deltaRetention is how long a line's deltas stay after its last update.
	deltaRetention = 30 * time.Minute
	// deltaLinesPerTenant caps the buffered lines of one tenant; the least
	// recently updated one is evicted first.
	deltaLinesPerTenant = 64
)

// DeltaTail is what StreamSince returns: the buffered deltas after the
// cursor, the newest seq handed out for the line (0 when none is buffered)
// and whether deltas after the cursor were lost (the buffer was trimmed,
// evicted or never held them). When Truncated is set, reload the messages.
type DeltaTail struct {
	Deltas    []domain.Delta `json:"deltas"`
	Seq       int64          `json:"seq"`
	Truncated bool           `json:"truncated"`
}

// deltaBuffer is the bounded tail of one line. startedAfter is the counter
// when the buffer was created: anything at or below it (an earlier buffer
// of the line that was evicted) is not here. lostUpTo is the newest seq that
// was dropped (trimmed or too large to keep).
type deltaBuffer struct {
	deltas       []domain.Delta
	bytes        int
	seq          int64
	startedAfter int64
	lostUpTo     int64
	updatedAt    time.Time
}

// deltaRegistry keeps the per-line tails grouped by tenant.
type deltaRegistry struct {
	mu      sync.Mutex
	tenants map[string]map[string]*deltaBuffer
	next    int64
	now     func() time.Time
}

func newDeltaRegistry(now func() time.Time) *deltaRegistry {
	return &deltaRegistry{tenants: map[string]map[string]*deltaBuffer{}, next: now().UnixMicro(), now: now}
}

// append stores one delta under the next sequence number and returns it as
// stored.
func (r *deltaRegistry) append(tenant, lineID string, delta domain.Delta) domain.Delta {
	r.mu.Lock()
	defer r.mu.Unlock()
	room := r.room(tenant)
	buffer := room[lineID]
	if buffer == nil {
		r.evict(tenant, room)
		room = r.room(tenant)
		buffer = &deltaBuffer{startedAfter: r.next}
		room[lineID] = buffer
	}
	buffer.updatedAt = r.now()
	r.next++
	delta.Seq = r.next
	buffer.seq = delta.Seq
	buffer.push(delta)
	return delta
}

// since returns the buffered deltas of a line after afterSeq. A cursor is
// truncated when deltas after it are gone: it has no buffer behind it, or
// it predates the line's current buffer (an earlier one was evicted), or a
// delta after it was dropped from this one.
func (r *deltaRegistry) since(tenant, lineID string, afterSeq int64) DeltaTail {
	r.mu.Lock()
	defer r.mu.Unlock()
	tail := DeltaTail{Deltas: []domain.Delta{}}
	buffer, ok := r.tenants[tenant][lineID]
	if !ok {
		tail.Truncated = afterSeq > 0
		return tail
	}
	tail.Seq = buffer.seq
	tail.Truncated = (afterSeq > 0 && afterSeq < buffer.startedAfter) || afterSeq < buffer.lostUpTo
	for _, delta := range buffer.deltas {
		if delta.Seq > afterSeq {
			tail.Deltas = append(tail.Deltas, delta)
		}
	}
	return tail
}

// text joins the buffered text deltas of one turn (the fallback partial of a
// turn that runs in another process).
func (r *deltaRegistry) text(tenant, lineID, turnID string, afterSeq int64) string {
	var b strings.Builder
	for _, delta := range r.since(tenant, lineID, afterSeq).Deltas {
		if delta.TurnID == turnID && delta.Kind == domain.DeltaText {
			b.WriteString(delta.Text)
		}
	}
	return b.String()
}

// forget drops the buffers of lines that went away.
func (r *deltaRegistry) forget(tenant string, lineIDs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	room := r.tenants[tenant]
	for _, id := range lineIDs {
		delete(room, id)
	}
	if len(room) == 0 {
		delete(r.tenants, tenant)
	}
}

// sweep drops expired buffers and empty tenants (Maintain calls it) and
// returns how many buffers it dropped.
func (r *deltaRegistry) sweep() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	dropped := 0
	now := r.now()
	for tenant, room := range r.tenants {
		for id, buffer := range room {
			if now.Sub(buffer.updatedAt) > deltaRetention {
				delete(room, id)
				dropped++
			}
		}
		if len(room) == 0 {
			delete(r.tenants, tenant)
		}
	}
	return dropped
}

func (r *deltaRegistry) room(tenant string) map[string]*deltaBuffer {
	room := r.tenants[tenant]
	if room == nil {
		room = map[string]*deltaBuffer{}
		r.tenants[tenant] = room
	}
	return room
}

// evict drops buffers past retention and, while the tenant is at its cap,
// the least recently updated one. Called under mu before a line is added.
func (r *deltaRegistry) evict(tenant string, room map[string]*deltaBuffer) {
	now := r.now()
	for id, buffer := range room {
		if now.Sub(buffer.updatedAt) > deltaRetention {
			delete(room, id)
		}
	}
	for len(room) >= deltaLinesPerTenant {
		oldest, oldestAt := "", time.Time{}
		for id, buffer := range room {
			if oldest == "" || buffer.updatedAt.Before(oldestAt) {
				oldest, oldestAt = id, buffer.updatedAt
			}
		}
		delete(room, oldest)
	}
	if len(room) == 0 {
		delete(r.tenants, tenant)
	}
}

// push appends a delta and trims the oldest until the tail fits the limit; a
// delta larger than the whole limit is not kept. Whatever is dropped is
// remembered in lostUpTo.
func (b *deltaBuffer) push(delta domain.Delta) {
	size := deltaSize(delta)
	if size > deltaBufferLimit {
		b.lostUpTo = delta.Seq
		return
	}
	b.deltas = append(b.deltas, delta)
	b.bytes += size
	for b.bytes > deltaBufferLimit && len(b.deltas) > 1 {
		b.bytes -= deltaSize(b.deltas[0])
		b.lostUpTo = b.deltas[0].Seq
		b.deltas = b.deltas[1:]
	}
}

func deltaSize(delta domain.Delta) int {
	return len(delta.Text) + len(delta.TurnID) + len(delta.Kind)
}
