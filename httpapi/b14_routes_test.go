package httpapi_test

import (
	"net/http"
	"testing"
)

// b14Seed opens a main line of its own with a reply, for the cross-model
// diverge (so it does not crowd the main line's open branches).
func (h *harness) b14Seed(s *seeded) {
	h.t.Helper()
	s.arena = h.line()
	s.arenaReply = h.turn(s.arena, "which queue?")
}

// b14Routes are the B14 routes: export, a diverge across models and a
// batch of seeds.
func b14Routes(s seeded) []routeCase {
	targets := []map[string]any{{"provider": "fake", "model": "fake-1"}, {"provider": "anthropic", "model": "claude-haiku-4-5"}}
	return []routeCase{
		{name: "export", method: "GET", path: "/lines/" + s.branch + "/export", lineScoped: true,
			bad: badRequest{path: "/lines/not-a-uuid/export", status: 404, code: "line_not_found"}},
		{name: "diverge models", method: "POST", path: "/lines/" + s.arena + "/diverge/models", body: map[string]any{"anchorMessageId": s.arenaReply, "targets": targets},
			write: true, lineScoped: true, feature: "diverge",
			bad: badRequest{body: map[string]any{"anchorMessageId": s.arenaReply, "targets": targets[:1]}, status: 400, code: "invalid_input"}},
		{name: "seeds batch", method: "POST", path: "/lines/" + s.main + "/seeds/batch", body: map[string]any{"texts": []string{"one", "two"}},
			write: true, lineScoped: true, feature: "parking",
			bad: badRequest{body: map[string]any{"texts": []string{}}, status: 400, code: "invalid_input"}},
	}
}

func TestB14Routes_SearchByRootAndTheShapes(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "the walrus question")
	branch := h.branch(main, reply, "walrus branch")
	other := h.line()
	h.turn(other, "another walrus")

	hits := h.ok(http.StatusOK, h.do(http.MethodGet, "/search?q=walrus&root="+main, nil))["hits"].([]any)
	// The branch's purpose, the question and the fake reply that echoes it.
	if len(hits) != 3 {
		t.Fatalf("hits = %v", hits)
	}
	for _, hit := range hits {
		if hit.(map[string]any)["rootLineId"] != main {
			t.Fatalf("a hit outside the tree: %v", hit)
		}
	}
	h.wantError(h.do(http.MethodGet, "/search?q=walrus&root="+branch, nil), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodGet, "/search?q=walrus&root=nope", nil), http.StatusNotFound, "line_not_found")

	out := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+branch+"/export", nil))
	if out["rootLineId"] != main || out["truncated"] != false || len(out["messagesByLine"].(map[string]any)) != 2 || out["goal"] != nil {
		t.Fatalf("export = %v", out)
	}
	for _, key := range []string{"notes", "memos", "chapters", "comparisons", "links", "branches"} {
		if _, ok := out[key].([]any); !ok {
			t.Fatalf("%s is a list: %v", key, out[key])
		}
	}
	if _, ok := out["foldsByLine"].(map[string]any); !ok {
		t.Fatalf("foldsByLine is an object: %v", out["foldsByLine"])
	}

	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/diverge/models", map[string]any{
		"anchorMessageId": reply, "purpose": "Compare", "targets": []map[string]any{{"provider": "fake", "model": "fake-1"}, {"provider": "fake", "model": "fake-2", "purpose": "Mine"}},
	}))
	branches := created["branches"].([]any)
	if created["parentLineId"] != main || len(branches) != 2 || field(branches[1].(map[string]any), "branch", "purpose") != "Mine" ||
		field(branches[0].(map[string]any), "line", "model") != "fake-1" {
		t.Fatalf("diverge/models = %v", created)
	}
	seeds := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+branch+"/seeds/batch", map[string]any{"texts": []string{"a", "b"}}))
	if seeds["rootLineId"] != main || len(seeds["seeds"].([]any)) != 2 {
		t.Fatalf("seeds/batch = %v", seeds)
	}
}
