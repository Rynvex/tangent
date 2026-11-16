package httpapi_test

import "net/http"

// b14 walks the B14 routes on a small conversation of its own: a search
// within it, a diverge across models, a batch of seeds and the export.
func (f *flow) b14() {
	main := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "Event queue", "provider": "fake", "model": "fake-1"}))["id"].(string)
	reply := f.turn(main, "Ring buffer or linked list for the event queue?")
	f.call("search.root", http.StatusOK, http.MethodGet, "/search?q=queue&root="+main, nil)
	f.call("diverge.models", http.StatusCreated, http.MethodPost, "/lines/"+main+"/diverge/models", map[string]any{
		"anchorMessageId": reply, "purpose": "Queue design",
		"targets": []map[string]any{{"provider": "fake", "model": "fake-1"}, {"provider": "anthropic", "model": "claude-haiku-4-5", "purpose": "The cheap take"}},
	})
	f.call("seeds.batch", http.StatusCreated, http.MethodPost, "/lines/"+main+"/seeds/batch", map[string]any{
		"anchorMessageId": reply, "texts": []string{"Benchmark both", "Check the allocator"},
	})
	f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+main+"/memos", map[string]any{"text": "Ask the team which one they know"}))
	f.call("lines.export", http.StatusOK, http.MethodGet, "/lines/"+main+"/export", nil)
}
