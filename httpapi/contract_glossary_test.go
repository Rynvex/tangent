package httpapi_test

import "net/http"

// glossary walks the B24 routes on a small conversation of its own: a term
// saved from an answered aside (which keeps it), the list, an edit, a
// search and a delete.
func (f *flow) glossary() {
	main := f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines", map[string]any{"title": "資料庫筆記", "provider": "fake", "model": "fake-1"}))["id"].(string)
	reply := f.turn(main, "MVCC 是什麼？")
	aside := f.answeredAside(main, reply, nil)
	created := f.call("terms.create", http.StatusCreated, http.MethodPost, "/lines/"+aside+"/terms", map[string]any{
		"term": "MVCC", "explanation": "多版本並行控制：讀不擋寫",
	})
	f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+main+"/terms", map[string]any{"term": "WAL", "explanation": "write-ahead log", "sourceMessageId": reply}))
	f.call("terms.list", http.StatusOK, http.MethodGet, "/lines/"+main+"/terms", nil)
	id := created["term"].(map[string]any)["id"].(string)
	f.call("terms.update", http.StatusOK, http.MethodPatch, "/terms/"+id, map[string]any{"explanation": "多版本並行控制"})
	f.call("terms.search", http.StatusOK, http.MethodGet, "/terms?q=mv", nil)
	f.ok(http.StatusNoContent, f.do(http.MethodDelete, "/terms/"+id, nil))
}
