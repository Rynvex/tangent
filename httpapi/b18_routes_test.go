package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// b18Routes are the B18 routes: importing, renaming a folder, extracting a
// stretch into a branch and the decompose plan; B20 attaching another
// conversation as a branch.
func b18Routes(s seeded) []routeCase {
	importBody := map[string]any{"messages": []map[string]any{{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}}}
	return []routeCase{
		{name: "import", method: "POST", path: "/lines/import", body: importBody, write: true,
			bad: badRequest{body: map[string]any{"messages": []any{}}, status: 400, code: "invalid_input"}},
		{name: "rename folder", method: "POST", path: "/lines/folders/rename", body: map[string]any{"from": "a", "to": "b"}, write: true,
			bad: badRequest{body: map[string]any{"from": " "}, status: 400, code: "invalid_input"}},
		{name: "extract", method: "POST", path: "/lines/" + s.main + "/branches/extract", write: true, lineScoped: true,
			body: map[string]any{"fromMessageId": s.secondQuestion, "toMessageId": s.secondReply, "purpose": "the second exchange"},
			bad:  badRequest{body: map[string]any{"fromMessageId": s.secondQuestion, "toMessageId": unknownID, "purpose": "p"}, status: 404, code: "message_not_found"}},
		{name: "decompose", method: "GET", path: "/lines/" + s.main + "/decompose", lineScoped: true,
			bad: badRequest{path: "/lines/not-a-uuid/decompose", status: 404, code: "line_not_found"}},
		{name: "organization", method: "GET", path: "/lines/organization"},
		{name: "attach", method: "POST", path: "/lines/" + s.main + "/attach", body: map[string]any{"sourceLineId": s.arena}, write: true, lineScoped: true,
			bad: badRequest{body: map[string]any{"sourceLineId": s.main}, status: 400, code: "invalid_input"}},
		{name: "import-analyze", method: "POST", path: "/lines/import-analyze",
			body: map[string]any{"units": []map[string]any{{"key": "u1", "question": "q", "answer": "a", "messageCount": 2}}},
			bad:  badRequest{body: map[string]any{"units": []any{}}, status: 400, code: "invalid_input"}},
	}
}

func TestB18Routes_TheNewPatternsNeverMeetTheLineIDRoutes(t *testing.T) {
	h := newHarness(t)
	// httpapi.New registered every pattern without a conflict (it panics on
	// one); each request reaches its own handler.
	imported := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", b18Import()))
	main := field(imported, "line", "id").(string)
	if got := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/folders/rename", map[string]any{"from": "資料庫研究", "to": "DB"})); got["updated"] != float64(1) {
		t.Fatalf("rename = %v", got)
	}
	h.wantError(h.do(http.MethodGet, "/lines/import", nil), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodPatch, "/lines/import", map[string]any{"title": "x"}), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodDelete, "/lines/folders", nil), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodGet, "/lines/folders/rename", nil), http.StatusNotFound, "not_found")
	h.wantError(h.do(http.MethodPost, "/lines/import/archive", nil), http.StatusNotFound, "line_not_found")
	if got := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main, nil)); got["folder"] != "DB" {
		t.Fatalf("the imported line moved folder: %v", got["folder"])
	}
	h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/decompose", nil, readOnly()))
	// GET /lines/organization is its own route (the literal segment wins over
	// {id}); the other methods still reach the {id} routes.
	organization := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/organization", nil, readOnly()))
	folders, tags := organization["folders"].([]any), organization["tags"].([]any)
	if len(folders) != 1 || folders[0].(map[string]any)["folder"] != "DB" || folders[0].(map[string]any)["active"] != float64(1) || len(tags) != 2 {
		t.Fatalf("organization = %v", organization)
	}
	h.wantError(h.do(http.MethodPatch, "/lines/organization", map[string]any{"title": "x"}), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodDelete, "/lines/organization", nil), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodGet, "/lines/organization/messages", nil), http.StatusNotFound, "line_not_found")
}

func TestB18Routes_LinesCarryFolderAndTagsEverywhere(t *testing.T) {
	h := newHarness(t)
	created := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "t", "folder": " Work ", "tags": []string{"#Go", "go"}}))
	main := created["id"].(string)
	if created["folder"] != "Work" || len(created["tags"].([]any)) != 1 {
		t.Fatalf("created = %v", created)
	}
	reply := h.turn(main, "q")
	branch := h.branch(main, reply, "side")
	r := h.do(http.MethodGet, "/lines/"+branch, nil)
	h.ok(http.StatusOK, r)
	if !strings.Contains(string(r.raw), `"folder":""`) || !strings.Contains(string(r.raw), `"tags":[]`) {
		t.Fatalf("a branch shows \"\" and []: %s", r.raw)
	}
	for _, ev := range h.events.OfType(tangent.EventLineCreated) {
		raw, _ := json.Marshal(ev.Data)
		if !strings.Contains(string(raw), `"tags":[`) || strings.Contains(string(raw), `"tags":null`) {
			t.Fatalf("an event carries tags as a list: %s", raw)
		}
	}
	h.wantError(h.do(http.MethodPatch, "/lines/"+branch, map[string]any{"folder": "x"}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPatch, "/lines/"+main, map[string]any{"tags": []string{strings.Repeat("t", 25)}}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPatch, "/lines/"+main, map[string]any{"tags": "go"}), http.StatusBadRequest, "invalid_input")
	patched := h.ok(http.StatusOK, h.do(http.MethodPatch, "/lines/"+main, map[string]any{"tags": []string{"SQL"}}))
	if patched["folder"] != "Work" || patched["tags"].([]any)[0] != "sql" {
		t.Fatalf("patched = %v", patched)
	}
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines", map[string]any{"title": "unfiled"}))
	for query, want := range map[string]int{"?folder=Work": 1, "?folder=__unfiled__": 1, "?tag=%23SQL": 1, "?tag=go": 0, "?folder=": 2, "?folder=Work&tag=sql": 1} {
		page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines"+query, nil))
		if got := len(page["lines"].([]any)); got != want {
			t.Fatalf("%s: %d lines, want %d", query, got, want)
		}
	}
	if page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines?folder=Work", nil, as(tenantB))); len(page["lines"].([]any)) != 0 {
		t.Fatalf("another tenant's folder is empty: %v", page)
	}
	h.wantError(h.do(http.MethodPost, "/lines/folders/rename", map[string]any{"from": "Work", "to": "x"}, readOnly()), http.StatusForbidden, "forbidden")
}

func TestB18Routes_ImportTakesALargeBodyWithinItsOwnLimit(t *testing.T) {
	h := newHarness(t, func(c *harnessConfig) { c.maxImportBody = 4 << 20 })
	content := strings.Repeat("x", 30000)
	messages := make([]map[string]any, 0, 40)
	for i := range 40 {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		messages = append(messages, map[string]any{"role": role, "content": content})
	}
	body := map[string]any{"title": "big", "messages": messages}
	out := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", body))
	if out["messageCount"] != float64(40) || len(out["branches"].([]any)) != 0 {
		t.Fatalf("imported = %v", out["messageCount"])
	}
	// Other routes keep the general limit.
	h.wantError(h.do(http.MethodPost, "/lines", map[string]any{"title": "t", "pad": strings.Repeat("x", 2<<20)}), http.StatusRequestEntityTooLarge, "payload_too_large")
	for range 4 {
		messages = append(messages, messages...)
	}
	h.wantError(h.do(http.MethodPost, "/lines/import", map[string]any{"messages": messages[:150]}), http.StatusRequestEntityTooLarge, "payload_too_large")
	h.wantError(h.do(http.MethodPost, "/lines/import", map[string]any{"messages": messages[:2], "hostMeta": map[string]any{"a": 1}}), http.StatusBadRequest, "invalid_input")
	long := map[string]any{"messages": []map[string]any{{"role": "user", "content": strings.Repeat("y", 32001)}}}
	h.wantError(h.do(http.MethodPost, "/lines/import", long), http.StatusUnprocessableEntity, "too_long")
}

func TestB18Routes_ExtractWithACardAndItsRefusals(t *testing.T) {
	h := newHarness(t)
	imported := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/import", b18Import()))
	main := field(imported, "line", "id").(string)
	page := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/messages", nil))
	ids := []string{}
	for _, m := range page["messages"].([]any) {
		ids = append(ids, m.(map[string]any)["id"].(string))
	}
	path := "/lines/" + main + "/branches/extract"
	h.wantError(h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[2], "toMessageId": ids[3], "purpose": "p", "card": "text"}), http.StatusUnprocessableEntity, "invalid_card")
	h.wantError(h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[2], "toMessageId": ids[3], "purpose": "p", "card": map[string]any{"question": "q"}}), http.StatusUnprocessableEntity, "invalid_card")
	h.wantError(h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[3], "toMessageId": ids[2], "purpose": "p"}), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[0], "toMessageId": ids[1], "purpose": "p"}), http.StatusBadRequest, "move_no_anchor")
	h.wantError(h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[3], "toMessageId": ids[4], "purpose": "p"}), http.StatusBadRequest, "move_must_start_with_user")

	plain := h.ok(http.StatusCreated, h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[6], "toMessageId": ids[7], "purpose": "tail", "card": nil}))
	if field(plain, "marker", "kind") != "branch_marker" || field(plain, "branch", "status") != "open" {
		t.Fatalf("a null card is no card: %v", plain)
	}
	carded := h.ok(http.StatusCreated, h.do(http.MethodPost, path, map[string]any{
		"fromMessageId": ids[2], "toMessageId": ids[3], "purpose": "Docker", "card": map[string]any{"question": "Why?", "conclusion": "Use the host network."},
	}))
	if field(carded, "marker", "kind") != "branch_card" || field(carded, "marker", "meta", "delivered") != true || field(carded, "branch", "status") != "merged" {
		t.Fatalf("carded = %v", carded)
	}
	h.wantError(h.do(http.MethodPost, path, map[string]any{"fromMessageId": ids[0], "toMessageId": ids[5], "purpose": "p"}), http.StatusBadRequest, "move_protected_message")
	after := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/messages", nil))["messages"].([]any)
	kinds := []string{}
	for _, m := range after {
		kinds = append(kinds, m.(map[string]any)["kind"].(string))
	}
	if strings.Join(kinds, ",") != "chat,chat,branch_card,chat,chat,branch_marker" {
		t.Fatalf("the card and the marker sit where their ranges were: %v", kinds)
	}
}
