package httpapi_test

import (
	"net/http"

	"github.com/Rynvex/tangent/tangent"
)

// b17 dismisses a tree's whole inbox at once and edits the card of a
// merged branch, on a small conversation of its own.
func (f *flow) b17() {
	main := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "Garden plan", "provider": "fake", "model": "fake-1"}))["id"].(string)
	reply := f.turn(main, "Which vegetables first? "+tangent.ProbeDirective)
	branch := f.harness.branch(main, reply, "Tomatoes or peppers")
	f.turn(branch, "Which grows faster? "+tangent.ProbeDirective)
	f.call("suggestions.dismiss.all", http.StatusOK, http.MethodPost, "/lines/"+main+"/suggestions/dismiss-all", nil)
	detail := f.ok(http.StatusOK, f.do(http.MethodGet, "/lines/"+branch+"/branch", nil))
	f.ok(http.StatusOK, f.do(http.MethodPost, "/lines/"+branch+"/branch/merge", map[string]any{
		"card": map[string]any{"question": "Tomatoes or peppers?", "conclusion": "Tomatoes"}, "parentTipMessageId": detail["parentTipMessageId"],
	}))
	f.call("branch.card.update", http.StatusOK, http.MethodPatch, "/lines/"+branch+"/branch/card", map[string]any{
		"card": map[string]any{"question": "Tomatoes or peppers?", "conclusion": "Tomatoes first, peppers in June", "openItems": []string{"Buy seedlings"}},
	})
}
