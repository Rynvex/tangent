package httpapi_test

import (
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/Rynvex/tangent/tangent"
)

// memorySamples are the sample names only the memory flow writes (a server
// without the vector extension leaves them as they are).
var memorySamples = []string{"route.memories.", "route.suggestions.list.memory", "route.suggestions.accept.memory", "route.preview.memories",
	"route.error.memory_", "route.error.invalid_memory", "route.error.embedder_unavailable", "event.memory."}

// skipMemorySamples counts the memory flow's samples as written.
func (s *sampler) skipMemorySamples() {
	files, _ := filepath.Glob(filepath.Join(contractDir, "*.json"))
	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".json")
		for _, prefix := range memorySamples {
			if strings.HasPrefix(name, prefix) {
				s.written[name] = true
			}
		}
	}
}

// p3c walks the B10 part C routes on an engine of its own with memory in
// suggest mode (the fake Embedder): a memory extracted after a merge and
// accepted, the operator's memories, the search and the turn recall, a
// supersede, a consolidation, and the refusals.
func (f *flow) p3c() *harness {
	h := newHarness(f.t, withMemory(tangent.ModeSuggest))
	g := &flow{harness: h, s: f.s}
	g.main = g.ok(http.StatusCreated, g.do(http.MethodPost, "/lines", map[string]any{"title": "Home server", "provider": "fake", "model": "fake-1"}))["id"].(string)
	g.reply = g.turn(g.main, "Which file system for the NAS?")
	branch := g.harness.branch(g.main, g.reply, "Disks")
	g.turn(branch, "Mirror or RAIDZ?")
	detail := g.ok(http.StatusOK, g.do(http.MethodGet, "/lines/"+branch+"/branch", nil))
	g.ok(http.StatusOK, g.do(http.MethodPost, "/lines/"+branch+"/branch/merge", map[string]any{
		"card": map[string]any{"question": "Mirror or RAIDZ?", "conclusion": "A ZFS mirror of two disks"}, "parentTipMessageId": detail["parentTipMessageId"],
	}))
	g.dispatcher.Wait()
	list := g.call("suggestions.list.memory", http.StatusOK, http.MethodGet, "/lines/"+g.main+"/suggestions", nil)
	g.call("suggestions.accept.memory", http.StatusOK, http.MethodPost, "/suggestions/"+onlyOfKind(g, list, tangent.SuggestionKindMemory)+"/accept", map[string]any{"importance": 7})
	g.p3cMemories()
	return h
}

func onlyOfKind(f *flow, list map[string]any, kind string) string {
	for _, s := range list["suggestions"].([]any) {
		if s := s.(map[string]any); s["kind"] == kind {
			return s["id"].(string)
		}
	}
	f.t.Fatalf("no %s suggestion: %v", kind, list)
	return ""
}

func (f *flow) p3cMemories() {
	created := f.call("memories.create", http.StatusCreated, http.MethodPost, "/memories", map[string]any{
		"kind": "decision", "text": "The NAS uses a ZFS mirror", "importance": 8, "sourceLineId": f.main,
	})
	id := field(created, "memory", "id").(string)
	f.call("memories.list", http.StatusOK, http.MethodGet, "/memories", nil)
	first := f.call("memories.list.page", http.StatusOK, http.MethodGet, "/memories?limit=1", nil)
	rest := f.ok(http.StatusOK, f.do(http.MethodGet, "/memories?limit=1&cursor="+url.QueryEscape(first["nextCursor"].(string)), nil))
	if len(rest["memories"].([]any)) != 1 || rest["nextCursor"] != "" {
		f.t.Fatalf("the second page = %v", rest)
	}
	f.call("memories.update", http.StatusOK, http.MethodPatch, "/memories/"+id, map[string]any{"importance": 9, "validUntil": "2030-01-01T00:00:00Z"})
	f.call("memories.search", http.StatusOK, http.MethodPost, "/memories/search", map[string]any{"query": "Which ZFS layout for the NAS?"})
	other := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "New NAS", "provider": "fake", "model": "fake-1"}))["id"].(string)
	f.call("preview.memories", http.StatusOK, http.MethodPost, "/lines/"+other+"/preview", map[string]any{"content": "Should the NAS use ZFS?"})
	f.call("memories.supersede", http.StatusCreated, http.MethodPost, "/memories/"+id+"/supersede", map[string]any{"text": "The NAS uses ZFS RAIDZ1"})
	f.fail("error.memory_superseded", http.StatusConflict, http.MethodPost, "/memories/"+id+"/supersede", map[string]any{"text": "again"})
	f.fail("error.memory_not_found", http.StatusNotFound, http.MethodPatch, "/memories/"+unknownID, map[string]any{"importance": 1})
	f.fail("error.invalid_memory", http.StatusUnprocessableEntity, http.MethodPost, "/memories", map[string]any{"kind": "rumour", "text": "x"})
	down := &flow{harness: newHarness(f.t, withBrokenEmbedder()), s: f.s}
	down.fail("error.embedder_unavailable", http.StatusServiceUnavailable, http.MethodPost, "/memories/search", map[string]any{"query": "fans"})
	f.call("memories.list.superseded", http.StatusOK, http.MethodGet, "/memories?status=superseded", nil)
	for _, text := range []string{"Quiet fans for the server", "quiet fans for the server"} {
		f.ok(http.StatusCreated, f.do(http.MethodPost, "/memories", map[string]any{"kind": "preference", "text": text, "sourceLineId": f.main}))
	}
	if _, err := f.engine.Maintain(f.ctx); err != nil {
		f.t.Fatal(err)
	}
	f.dispatcher.Wait()
	list := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+f.main+"/suggestions", nil))
	f.call("suggestions.accept.memory_consolidate", http.StatusOK, http.MethodPost, "/suggestions/"+onlyOfKind(f, list, tangent.SuggestionKindMemoryConsolidate)+"/accept", map[string]any{})
}
