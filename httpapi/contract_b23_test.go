package httpapi_test

import (
	"net/http"
)

// b23 keeps an answered aside, continues it as a branch and deletes a
// discarded branch, on a small conversation of its own (B23).
func (f *flow) b23() {
	main := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "連線池調校", "provider": "fake", "model": "fake-1"}))["id"].(string)
	reply := f.turn(main, "PG 連線池要開多大？")
	aside := f.answeredAside(main, reply, nil)
	f.call("branch.keep", http.StatusOK, http.MethodPut, "/lines/"+aside+"/branch/keep", map[string]any{"keep": true})
	f.call("branch.continue", http.StatusCreated, http.MethodPost, "/lines/"+aside+"/branch/continue", map[string]any{"purpose": "連線池的大小怎麼估"})
	discarded := f.harness.branch(main, reply, "改用 PgBouncer")
	f.ok(http.StatusOK, f.do(http.MethodPost, "/lines/"+discarded+"/branch/discard", nil))
	f.call("branch.delete", http.StatusOK, http.MethodDelete, "/lines/"+discarded+"/branch", nil)
}
