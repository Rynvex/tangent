package httpapi_test

import "net/http"

// b15Relations draws a relation with a kind on a small conversation of its
// own.
func (f *flow) b15Relations() {
	main := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "Cache design", "provider": "fake", "model": "fake-1"}))["id"].(string)
	reply := f.turn(main, "Write-through or write-back?")
	through := f.harness.branch(main, reply, "Write-through")
	back := f.harness.branch(main, reply, "Write-back")
	f.call("relations.kind", http.StatusCreated, http.MethodPost, "/lines/"+main+"/relations", map[string]any{
		"fromLineId": through, "toLineId": back, "label": "Opposite answers to the same question", "relationKind": "contradicts",
	})
}

// b15Tags puts a confirmed tag back as a draft and lists the tree's drafts
// (on the ibis flow, after its folds).
func (f *flow) b15Tags(messageID string) {
	f.call("messages.tag.draft", http.StatusOK, http.MethodPut, "/messages/"+messageID+"/tag", map[string]any{"kind": "decision", "status": "draft"})
	f.call("ibis.drafts", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/tag-drafts", nil)
}
