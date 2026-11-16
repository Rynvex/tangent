package main

import (
	"context"
	"fmt"
	"net/url"
)

// memoryView is one tenant memory.
type memoryView struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	Text         string `json:"text"`
	Status       string `json:"status"`
	SupersededBy string `json:"supersededBy"`
	Importance   int    `json:"importance"`
}

// memoryKinds are the kinds of a memory.
var memoryKinds = []string{"fact", "decision", "preference", "lesson"}

// memoryTopics make the soak's memories share words, so search and recall
// find them (the fake Embedder hashes words).
var memoryTopics = []string{"ZFS mirror for the NAS", "Kyoto trip in spring", "雙向鏈結串列 linked list", "Postgres connection pool"}

// memories writes, lists, searches, recalls, re-files or supersedes the
// tenant's memories (shared by every worker).
func (w *worker) memories(ctx context.Context, t *tree, _ string) {
	var list struct {
		Memories []memoryView `json:"memories"`
	}
	status := []string{"active", "active", "superseded", "all"}[w.rng.IntN(4)]
	if err := w.c.call(ctx, "GET", "/memories?limit=50&status="+url.QueryEscape(status), nil, &list); !w.st.classify("memory list", err) || err != nil {
		return
	}
	active := []memoryView{}
	for _, m := range list.Memories {
		if m.Status == "active" {
			active = append(active, m)
		}
	}
	if len(active) == 0 || w.rng.IntN(4) == 0 {
		w.createMemory(ctx, t)
		return
	}
	m := active[w.rng.IntN(len(active))]
	switch roll := w.rng.IntN(100); {
	case roll < 25:
		w.searchMemories(ctx, m)
	case roll < 50:
		w.recall(ctx, t, m)
	case roll < 70:
		w.st.classify("memory update", w.c.call(ctx, "PATCH", "/memories/"+m.ID, map[string]any{"importance": 1 + w.rng.IntN(10)}, nil), "memory_superseded")
	default:
		w.supersedeMemory(ctx, m)
	}
}

func (w *worker) createMemory(ctx context.Context, t *tree) {
	body := map[string]any{
		"kind":       memoryKinds[w.rng.IntN(len(memoryKinds))],
		"text":       fmt.Sprintf("%s, soak %d note %d", memoryTopics[w.rng.IntN(len(memoryTopics))], w.id, w.rng.IntN(1e6)),
		"importance": 1 + w.rng.IntN(10),
	}
	if w.rng.IntN(2) == 0 {
		body["sourceLineId"] = t.main
	}
	var out struct {
		Memory memoryView `json:"memory"`
	}
	if err := w.c.call(ctx, "POST", "/memories", body, &out); w.st.classify("memory create", err) && err == nil && (out.Memory.ID == "" || out.Memory.Status != "active") {
		w.st.fail("memory create", "the new memory is %+v", out.Memory)
	}
}

// searchMemories looks a memory up by its own text: something must come back.
func (w *worker) searchMemories(ctx context.Context, m memoryView) {
	var out struct {
		Results []struct {
			Memory memoryView `json:"memory"`
		} `json:"results"`
	}
	err := w.c.call(ctx, "POST", "/memories/search", map[string]any{"query": m.Text, "limit": 5}, &out)
	if w.st.classify("memory search", err) && err == nil && len(out.Results) == 0 {
		w.inv.violate("searching memories for %q (memory %s) found nothing", m.Text, m.ID)
	}
}

// recall previews a turn about a memory's text: the prompt must recall
// at least one memory.
func (w *worker) recall(ctx context.Context, t *tree, m memoryView) {
	preview, ok := w.previewWith(ctx, t.main, "memory recall", m.Text)
	if ok && len(preview.Memories) == 0 {
		w.inv.violate("a turn about %q (memory %s) recalled nothing", m.Text, m.ID)
	}
}

// revisedKeepRunes bounds how much of the old text a revision keeps, so
// revisions of revisions stay under the length limit.
const revisedKeepRunes = 150

func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// supersedeMemory replaces a memory and checks the old one points at the new.
func (w *worker) supersedeMemory(ctx context.Context, m memoryView) {
	var out struct {
		Memory     memoryView   `json:"memory"`
		Superseded []memoryView `json:"superseded"`
	}
	body := map[string]any{"text": fmt.Sprintf("%s (revised %d)", truncateRunes(m.Text, revisedKeepRunes), w.rng.IntN(1000))}
	err := w.c.call(ctx, "POST", "/memories/"+m.ID+"/supersede", body, &out)
	if !w.st.classify("memory supersede", err, "memory_superseded") || err != nil {
		return
	}
	if len(out.Superseded) != 1 || out.Superseded[0].ID != m.ID || out.Superseded[0].SupersededBy != out.Memory.ID || out.Memory.Status != "active" {
		w.st.fail("memory supersede", "superseding %s gave %+v, superseded %+v", m.ID, out.Memory, out.Superseded)
	}
}
