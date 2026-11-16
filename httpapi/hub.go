package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Rynvex/tangent/tangent"
)

// Defaults of a Hub.
const (
	DefaultClientBuffer     = 256
	DefaultKeepalive        = 25 * time.Second
	DefaultMaxStreams       = 256
	DefaultMaxTenantStreams = 16
	DefaultWriteTimeout     = 10 * time.Second
	// DefaultMaxLag is how long a client may keep losing events (its queue
	// never drained in between) before its stream ends.
	DefaultMaxLag = 30 * time.Second
)

// EventStreamLagged is sent to a client that lost events because it read
// too slowly; it should reload what it shows. Data: {"dropped": n}.
const EventStreamLagged = "stream.lagged"

// LaggedEvent is the stream.lagged notice the hub sends a client that lost
// dropped events.
func LaggedEvent(tenant string, dropped int64) tangent.Event {
	return tangent.Event{Type: EventStreamLagged, Tenant: tenant, Data: map[string]int64{"dropped": dropped}}
}

// Hub fans engine events out to SSE clients, per tenant. It is a
// tangent.Publisher: pass it to tangent.WithPublisher and to Config.Hub. A
// slow client loses its oldest queued events and is told so with a
// stream.lagged event; one that stays behind is disconnected. Every client
// gets a keepalive comment line so proxies keep the connection open, and
// every write has a deadline. Streams are capped per tenant and in total.
// A stream opened with a delta filter (Config.DeltaFilter) gets each
// message.delta event as its filter leaves it, decided on that stream's own
// goroutine; every other event is encoded once for all.
type Hub struct {
	buffer       int
	keepalive    time.Duration
	maxStreams   int
	maxTenant    int
	writeTimeout time.Duration
	maxLag       time.Duration
	log          *slog.Logger
	now          func() time.Time

	mu     sync.RWMutex
	rooms  map[string]map[*client]struct{}
	count  int
	closed bool
	done   chan struct{}
}

// HubOption configures a Hub.
type HubOption func(*Hub)

// WithClientBuffer sets how many events wait for one client.
func WithClientBuffer(n int) HubOption {
	return func(h *Hub) {
		if n > 0 {
			h.buffer = n
		}
	}
}

// WithKeepalive sets the keepalive interval.
func WithKeepalive(d time.Duration) HubOption {
	return func(h *Hub) {
		if d > 0 {
			h.keepalive = d
		}
	}
}

// WithMaxStreams caps the open streams in total and per tenant; more are
// refused with 503 unavailable.
func WithMaxStreams(total, perTenant int) HubOption {
	return func(h *Hub) {
		if total > 0 {
			h.maxStreams = total
		}
		if perTenant > 0 {
			h.maxTenant = perTenant
		}
	}
}

// WithWriteTimeout bounds one write to a client; a client that does not
// take a write in time is disconnected.
func WithWriteTimeout(d time.Duration) HubOption {
	return func(h *Hub) {
		if d > 0 {
			h.writeTimeout = d
		}
	}
}

// WithMaxLag sets how long a client may keep losing events before its
// stream ends.
func WithMaxLag(d time.Duration) HubOption {
	return func(h *Hub) {
		if d > 0 {
			h.maxLag = d
		}
	}
}

// WithHubLogger sets where the hub logs events it cannot encode.
func WithHubLogger(l *slog.Logger) HubOption {
	return func(h *Hub) {
		if l != nil {
			h.log = l
		}
	}
}

// NewHub returns a hub without clients.
func NewHub(opts ...HubOption) *Hub {
	h := &Hub{
		buffer: DefaultClientBuffer, keepalive: DefaultKeepalive, maxStreams: DefaultMaxStreams, maxTenant: DefaultMaxTenantStreams,
		writeTimeout: DefaultWriteTimeout, maxLag: DefaultMaxLag, log: slog.Default(), now: time.Now, rooms: map[string]map[*client]struct{}{}, done: make(chan struct{}),
	}
	for _, opt := range opts {
		if opt != nil {
			opt(h)
		}
	}
	return h
}

type client struct {
	send chan queued
	// filter is the reader's delta filter; nil sends every delta.
	filter  deltaFilter
	dropped atomic.Int64
}

// queued is one message waiting for a client: encoded, or a message.delta
// event its filter has yet to see.
type queued struct {
	message []byte
	delta   *tangent.Event
}

// offer queues a message without blocking; a full queue drops its oldest
// and counts it.
func (c *client) offer(item queued) {
	for {
		select {
		case c.send <- item:
			return
		default:
		}
		select {
		case <-c.send:
			c.dropped.Add(1)
		default:
		}
	}
}

// Publish sends an event to every client of its tenant as
// "event: <type>\ndata: <json envelope>\n\n".
func (h *Hub) Publish(_ context.Context, ev tangent.Event) {
	message, err := sseMessage(ev)
	if err != nil {
		h.log.Error("tangent httpapi: event not encoded", "type", ev.Type, "error", err)
		return
	}
	shared := queued{message: message}
	var delta *tangent.Event
	if ev.Type == tangent.EventMessageDelta {
		delta = &ev
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.rooms[ev.Tenant] {
		if delta != nil && c.filter != nil {
			c.offer(queued{delta: delta})
			continue
		}
		c.offer(shared)
	}
}

func sseMessage(ev tangent.Event) ([]byte, error) {
	data, err := json.Marshal(ev)
	if err != nil {
		return nil, err
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", ev.Type, data)), nil
}

// Clients counts the connected clients.
func (h *Hub) Clients() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.count
}

// Close ends every stream and refuses new ones (call it when the server
// shuts down, so open streams do not hold the shutdown up).
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.closed {
		h.closed = true
		close(h.done)
	}
}

func (h *Hub) add(tenant string, filter deltaFilter) (*client, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch {
	case h.closed:
		return nil, apiError(CodeUnavailable, "the event stream is closed")
	case h.count >= h.maxStreams || len(h.rooms[tenant]) >= h.maxTenant:
		return nil, apiError(CodeUnavailable, "too many event streams are open; try again later")
	}
	c := &client{send: make(chan queued, h.buffer), filter: filter}
	room := h.rooms[tenant]
	if room == nil {
		room = map[*client]struct{}{}
		h.rooms[tenant] = room
	}
	room[c] = struct{}{}
	h.count++
	return c, nil
}

func (h *Hub) remove(tenant string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room := h.rooms[tenant]; room != nil {
		if _, ok := room[c]; ok {
			delete(room, c)
			h.count--
		}
		if len(room) == 0 {
			delete(h.rooms, tenant)
		}
	}
}

// stream is one client's connection.
type stream struct {
	h          *Hub
	w          http.ResponseWriter
	controller *http.ResponseController
	tenant     string
	lagSince   time.Time
}

// serve streams the tenant's events, deltas as filter leaves them (nil: all
// of them), until the client leaves, falls behind for good, misses a write
// deadline or the hub closes.
func (h *Hub) serve(w http.ResponseWriter, r *http.Request, tenant string, filter deltaFilter) error {
	c, err := h.add(tenant, filter)
	if err != nil {
		return err
	}
	defer h.remove(tenant, c)
	s := &stream{h: h, w: w, controller: http.NewResponseController(w), tenant: tenant}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if s.write([]byte(": connected\n\n")) != nil {
		return nil
	}
	ticker := time.NewTicker(h.keepalive)
	defer ticker.Stop()
	for {
		var message []byte
		select {
		case <-r.Context().Done():
			return nil
		case <-h.done:
			return nil
		case <-ticker.C:
			message = []byte(": keepalive\n\n")
		case item := <-c.send:
			if message = h.render(c, item); message == nil {
				continue
			}
		}
		if !s.caughtUp(c) || s.write(message) != nil {
			return nil
		}
	}
}

// render is what a queued item writes to its client: the encoded message,
// or a delta event as the client's filter leaves it (nil: nothing).
func (h *Hub) render(c *client, item queued) []byte {
	if item.delta == nil {
		return item.message
	}
	message, err := c.filter.event(*item.delta)
	if err != nil {
		h.log.Error("tangent httpapi: delta event not filtered; it is left out", "line", item.delta.LineID, "error", err)
		return nil
	}
	return message
}

// caughtUp tells the client about dropped events before the next write;
// false when it has been losing events for longer than maxLag.
func (s *stream) caughtUp(c *client) bool {
	dropped := c.dropped.Swap(0)
	now := s.h.now()
	if dropped == 0 {
		if len(c.send) == 0 {
			s.lagSince = time.Time{}
		}
		return true
	}
	if s.lagSince.IsZero() {
		s.lagSince = now
	} else if now.Sub(s.lagSince) > s.h.maxLag {
		return false
	}
	notice, err := sseMessage(LaggedEvent(s.tenant, dropped))
	return err == nil && s.write(notice) == nil
}

// write sends one message under the write deadline and flushes it.
func (s *stream) write(message []byte) error {
	_ = s.controller.SetWriteDeadline(time.Now().Add(s.h.writeTimeout))
	if _, err := s.w.Write(message); err != nil {
		return err
	}
	return s.controller.Flush()
}

// events is GET /events.
func (a *api) events(c *call) {
	if strings.TrimSpace(c.scope.Tenant) == "" {
		a.writeError(c.w, c.r, invalid("the scope has no tenant"))
		return
	}
	if err := a.hub.serve(c.w, c.r, c.scope.Tenant, a.readerFilter(c.r)); err != nil {
		a.writeError(c.w, c.r, err)
	}
}
