package httpapi_test

import "net/http"

// memos walks the B13 routes: memos on the main line and on a branch, one
// node's list, an edit and a delete, with the not-found answer.
func (f *flow) memos() {
	created := f.call("memos.create", http.StatusCreated, http.MethodPost, "/lines/"+f.main+"/memos", map[string]any{
		"lineId": f.branch, "text": "Ask the landlord about the router\nbefore Friday",
	})
	f.ok(http.StatusCreated, f.do(http.MethodPost, "/lines/"+f.main+"/memos", map[string]any{"text": "A thought on the main line"}))
	f.call("memos.list", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/memos", nil)
	f.call("memos.list.node", http.StatusOK, http.MethodGet, "/lines/"+f.main+"/memos?lineId="+f.branch, nil)
	id := created["memo"].(map[string]any)["id"].(string)
	f.call("memos.update", http.StatusOK, http.MethodPatch, "/memos/"+id, map[string]any{"text": "Ask the landlord about the router"})
	f.call("memos.delete", http.StatusOK, http.MethodDelete, "/memos/"+id, nil)
	f.fail("error.memo_not_found", http.StatusNotFound, http.MethodPatch, "/memos/"+id, map[string]any{"text": "gone"})
}
