package httpapi_test

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/runner/fake"
	"github.com/Rynvex/tangent/tangent"
)

// withMemory adds memory (manual, the fake Embedder) to a harness; the
// schema gets its migration (the test skips without the vector extension).
func withMemory(mode tangent.Mode) func(*harnessConfig) {
	return func(c *harnessConfig) {
		c.migrate = append(c.migrate, tangent.FeatureMemory)
		c.features = append(c.features, tangent.Memory(mode, tangent.MemoryConfig{Embedder: fake.NewEmbedder(0)}))
	}
}

// withBrokenEmbedder adds memory (manual) with an Embedder that always fails.
func withBrokenEmbedder() func(*harnessConfig) {
	return func(c *harnessConfig) {
		c.migrate = append(c.migrate, tangent.FeatureMemory)
		c.features = append(c.features, tangent.Memory(tangent.ModeManual, tangent.MemoryConfig{Embedder: brokenEmbedder{}}))
	}
}

// brokenEmbedder is an Embedder whose service is down.
type brokenEmbedder struct{}

func (brokenEmbedder) Dim() int { return 8 }

func (brokenEmbedder) Embed(context.Context, []string) ([][]float32, error) {
	return nil, errors.New("upstream said: secret-ish detail")
}

// TestMemoryRoutes_AnUnavailableEmbedderIs503: the writes and the search
// that need a vector answer 503 embedder_unavailable without the cause; a
// turn's preview goes on without memories.
func TestMemoryRoutes_AnUnavailableEmbedderIs503(t *testing.T) {
	h := newHarness(t, withBrokenEmbedder())
	for _, r := range []response{
		h.do(http.MethodPost, "/memories", map[string]any{"kind": "fact", "text": "Fans should be quiet"}),
		h.do(http.MethodPost, "/memories/search", map[string]any{"query": "fans"}),
	} {
		h.wantError(r, http.StatusServiceUnavailable, "embedder_unavailable")
		if strings.Contains(string(r.raw), "secret-ish") {
			t.Fatalf("the cause leaks: %s", r.raw)
		}
	}
	main := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "x", "provider": "fake", "model": "fake-1"}))["id"].(string)
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+main+"/preview", map[string]any{"content": "fans?"}))
}

// memorySeed writes one memory and returns its id.
func (h *harness) memorySeed() string {
	h.t.Helper()
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/memories", map[string]any{"kind": "decision", "text": "The NAS uses a ZFS mirror", "importance": 8}))
	return field(created, "memory", "id").(string)
}

// memoryRoutes are the B10 part C routes. They live outside the route
// table: they need the vector extension, which a host may not have.
func memoryRoutes(id string) []routeCase {
	return []routeCase{
		{name: "list memories", method: "GET", path: "/memories", feature: tangent.FeatureMemory, bad: badRequest{path: "/memories?status=nope", status: 400, code: "invalid_input"}},
		{name: "create memory", method: "POST", path: "/memories", body: map[string]any{"kind": "fact", "text": "Fans should be quiet"}, write: true, feature: tangent.FeatureMemory,
			bad: badRequest{body: map[string]any{"kind": "rumour", "text": "x"}, status: 422, code: "invalid_memory"}},
		{name: "update memory", method: "PATCH", path: "/memories/" + id, body: map[string]any{"importance": 7}, write: true, lineScoped: true, feature: tangent.FeatureMemory,
			bad: badRequest{path: "/memories/x", status: 404, code: "memory_not_found"}},
		{name: "supersede memory", method: "POST", path: "/memories/" + id + "/supersede", body: map[string]any{"text": "The NAS uses ZFS RAIDZ1"}, write: true, lineScoped: true,
			feature: tangent.FeatureMemory, bad: badRequest{body: map[string]any{"text": " "}, status: 422, code: "invalid_memory"}},
		{name: "search memories", method: "POST", path: "/memories/search", body: map[string]any{"query": "Which ZFS layout for the NAS?"}, feature: tangent.FeatureMemory,
			bad: badRequest{body: map[string]any{"query": " "}, status: 400, code: "invalid_input"}},
	}
}

func TestMemoryRoutes_TheChecksOfTheRouteTable(t *testing.T) {
	h := newHarness(t, withMemory(tangent.ModeManual))
	id := h.memorySeed()
	cases := memoryRoutes(id)
	for _, rc := range cases {
		path := rc.bad.path
		if path == "" {
			path = rc.path
		}
		body := rc.bad.body
		if body == nil {
			body = rc.body
		}
		h.wantError(h.do(rc.method, path, body), rc.bad.status, rc.bad.code)
		h.wantError(h.do(rc.method, rc.path, rc.body, anonymous()), http.StatusUnauthorized, "unauthorized")
		r := h.do(rc.method, rc.path, rc.body, readOnly())
		if rc.write {
			h.wantError(r, http.StatusForbidden, "forbidden")
		} else if r.status != http.StatusOK {
			t.Errorf("%s: a read-only caller may read: %d %s", rc.name, r.status, r.raw)
		}
		if rc.lineScoped {
			h.wantError(h.do(rc.method, rc.path, rc.body, as(tenantB)), http.StatusNotFound, "memory_not_found")
		}
		off := h.do(rc.method, rc.path, rc.body, as(tenantOff))
		h.wantError(off, http.StatusNotFound, "feature_disabled")
	}
	theirs := h.ok(http.StatusOK, h.do(http.MethodPost, "/memories/search", map[string]any{"query": "ZFS NAS"}, as(tenantB)))
	if len(theirs["results"].([]any)) != 0 || len(h.ok(http.StatusOK, h.do(http.MethodGet, "/memories", nil, as(tenantB)))["memories"].([]any)) != 0 {
		t.Fatalf("tenant B sees nothing of A's: %v", theirs)
	}
	bare := newHarness(t)
	for _, rc := range cases {
		bare.wantError(bare.do(rc.method, rc.path, rc.body), http.StatusNotFound, "not_found")
	}
}

func TestMemoryRoutes_EveryWriteRunsTheHostsHook(t *testing.T) {
	calls := newHostCalls(false)
	h := newHarness(t, withHost(calls), withMemory(tangent.ModeManual))
	id := h.memorySeed()
	calls.mu.Lock()
	calls.refuse, calls.ops = true, map[string]string{}
	calls.mu.Unlock()
	before := len(h.events.Events())
	for _, rc := range memoryRoutes(id) {
		if !rc.write {
			continue
		}
		if r := h.do(rc.method, rc.path, rc.body); r.status != http.StatusTeapot || r.code() != codeHostRefused {
			t.Errorf("%s: got %d %s", rc.name, r.status, r.raw)
		}
	}
	if after := len(h.events.Events()); after != before {
		t.Fatalf("refused writes published %d events", after-before)
	}
	if len(calls.ops) != 3 {
		t.Fatalf("ops = %v", calls.ops)
	}
}

func TestMemoryRoutes_BodiesAndTheSearch(t *testing.T) {
	h := newHarness(t, withMemory(tangent.ModeManual))
	id := h.memorySeed()
	main := h.line()
	h.wantError(h.do(http.MethodPost, "/memories", map[string]any{"kind": "fact", "text": "x", "sourceLineId": "not-a-uuid"}), http.StatusNotFound, "line_not_found")
	sourced := h.ok(http.StatusCreated, h.do(http.MethodPost, "/memories", map[string]any{"kind": "fact", "text": "Main facts", "sourceLineId": main, "validUntil": "2030-01-01T00:00:00Z"}))
	if field(sourced, "memory", "source", "label") != "main" || field(sourced, "memory", "validUntil") != "2030-01-01T00:00:00Z" {
		t.Fatalf("sourced = %v", sourced)
	}
	cleared := h.ok(http.StatusOK, h.do(http.MethodPatch, "/memories/"+field(sourced, "memory", "id").(string), map[string]any{"validUntil": nil}))
	if field(cleared, "memory", "validUntil") != nil {
		t.Fatalf("null clears: %v", cleared)
	}
	h.wantError(h.do(http.MethodPatch, "/memories/"+id, map[string]any{"validUntil": "soon"}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPost, "/memories", map[string]any{"kind": "fact", "text": strings.Repeat("m", 501)}), http.StatusUnprocessableEntity, "too_long")
	found := h.ok(http.StatusOK, h.do(http.MethodPost, "/memories/search", map[string]any{"query": "ZFS layout for the NAS", "limit": 3}))
	results := found["results"].([]any)
	if len(results) != 1 || field(results[0].(map[string]any), "memory", "id") != id || found["query"] != "ZFS layout for the NAS" {
		t.Fatalf("found = %v", found)
	}
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/memories/"+id+"/supersede", map[string]any{"text": "ZFS RAIDZ1"}))
	h.wantError(h.do(http.MethodPost, "/memories/"+id+"/supersede", map[string]any{"text": "again"}), http.StatusConflict, "memory_superseded")
	h.wantError(h.do(http.MethodGet, "/memories?cursor=garbage", nil), http.StatusBadRequest, "invalid_input")
	history := h.ok(http.StatusOK, h.do(http.MethodGet, "/memories?status=superseded&kind=decision", nil))
	if len(history["memories"].([]any)) != 1 || field(history, "limits", "textMaxRunes") != float64(500) {
		t.Fatalf("history = %v", history)
	}
}

// TestMemoryRoutes_ThePagesFollowTheCursor: newest first, limit per page,
// nextCursor until the last page; the filters hold on every page.
func TestMemoryRoutes_ThePagesFollowTheCursor(t *testing.T) {
	h := newHarness(t, withMemory(tangent.ModeManual))
	var want []string
	for _, text := range []string{"one", "two", "three", "four", "five"} {
		created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/memories", map[string]any{"kind": "fact", "text": text}))
		want = append([]string{field(created, "memory", "id").(string)}, want...)
	}
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/memories", map[string]any{"kind": "lesson", "text": "not a fact"}))
	var got []string
	path := "/memories?kind=fact&limit=2"
	for pages := 0; ; pages++ {
		if pages > 3 {
			t.Fatalf("too many pages: %v", got)
		}
		page := h.ok(http.StatusOK, h.do(http.MethodGet, path, nil))
		for _, m := range page["memories"].([]any) {
			got = append(got, m.(map[string]any)["id"].(string))
		}
		next := page["nextCursor"].(string)
		if next == "" {
			break
		}
		path = "/memories?kind=fact&limit=2&cursor=" + url.QueryEscape(next)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("pages = %v, want %v", got, want)
	}
	if last := h.ok(http.StatusOK, h.do(http.MethodGet, "/memories?status=all", nil)); last["nextCursor"] != "" || len(last["memories"].([]any)) != 6 {
		t.Fatalf("one page = %v", last)
	}
}
