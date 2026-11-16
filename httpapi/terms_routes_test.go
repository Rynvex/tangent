package httpapi_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// B24: the glossary routes.

// termSeed saves a term on the main line.
func (h *harness) termSeed(s *seeded) {
	h.t.Helper()
	saved := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+s.main+"/terms", map[string]any{"term": "MVCC", "explanation": "row versions"}))
	s.term = field(saved, "term", "id").(string)
}

// termRoutes are the glossary routes.
func termRoutes(s seeded) []routeCase {
	line, term := "/lines/"+s.main+"/terms", "/terms/"+s.term
	return []routeCase{
		{name: "list terms", method: "GET", path: line, lineScoped: true, feature: "glossary",
			bad: badRequest{path: "/lines/not-a-uuid/terms", status: 404, code: "line_not_found"}},
		{name: "create term", method: "POST", path: line, body: map[string]any{"term": "WAL", "explanation": "a log", "replace": true}, write: true, lineScoped: true, feature: "glossary",
			bad: badRequest{body: map[string]any{"term": " ", "explanation": "x"}, status: 400, code: "invalid_input"}},
		{name: "update term", method: "PATCH", path: term, body: map[string]any{"explanation": "versions of rows"}, write: true, lineScoped: true, feature: "glossary",
			bad: badRequest{body: map[string]any{}, status: 400, code: "invalid_input"}},
		{name: "delete term", method: "DELETE", path: term, write: true, lineScoped: true, feature: "glossary",
			bad: badRequest{path: "/terms/not-a-uuid", status: 404, code: "term_not_found"}},
		{name: "search terms", method: "GET", path: "/terms?q=mv", feature: "glossary",
			bad: badRequest{path: "/terms?limit=0", status: 400, code: "invalid_input"}},
	}
}

func TestTermRoutes_SaveListEditDeleteAndSearch(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "what is MVCC?")
	saved := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/terms", map[string]any{"term": " MVCC ", "explanation": "row versions", "sourceMessageId": reply}))
	if field(saved, "change") != "created" || field(saved, "term", "termKey") != "mvcc" || field(saved, "term", "sourceMessageId") != reply {
		t.Fatalf("saved = %v", saved)
	}
	if _, has := saved["keptBranch"]; has {
		t.Fatalf("a save on the main line keeps no aside: %v", saved)
	}
	id := field(saved, "term", "id").(string)

	clash := h.do(http.MethodPost, "/lines/"+main+"/terms", map[string]any{"term": "mvcc", "explanation": "again"})
	h.wantError(clash, http.StatusConflict, "term_exists")
	if field(clash.json(t), "term", "id") != id {
		t.Fatalf("term_exists names the stored term: %s", clash.raw)
	}
	replaced := h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+main+"/terms", map[string]any{"term": "mvcc", "explanation": "again", "replace": true}))
	if field(replaced, "change") != "updated" || field(replaced, "term", "explanation") != "again" || field(replaced, "term", "term") != "MVCC" {
		t.Fatalf("replaced = %v", replaced)
	}
	h.wantError(h.do(http.MethodPost, "/lines/"+main+"/terms", map[string]any{"term": "x", "explanation": "x", "sourceMessageId": "nope"}), http.StatusNotFound, "message_not_found")

	list := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/terms", nil))
	if list["rootLineId"] != main || len(list["terms"].([]any)) != 1 || field(list, "limits", "maxTotal") != float64(300) ||
		field(list, "limits", "termMaxRunes") != float64(60) || field(list, "limits", "explanationMaxRunes") != float64(1000) {
		t.Fatalf("list = %v", list)
	}
	edited := h.ok(http.StatusOK, h.do(http.MethodPatch, "/terms/"+id, map[string]any{"term": "Multi-version CC"}))
	if field(edited, "term", "term") != "Multi-version CC" || field(edited, "term", "explanation") != "again" {
		t.Fatalf("edited = %v", edited)
	}
	found := h.ok(http.StatusOK, h.do(http.MethodGet, "/terms?q=multi&limit=5", nil))
	hits := found["terms"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["rootTitle"] != "main" || found["nextCursor"] != "" {
		t.Fatalf("found = %v", found)
	}
	h.wantError(h.do(http.MethodGet, "/terms?cursor=nope", nil), http.StatusBadRequest, "invalid_input")

	gone := h.do(http.MethodDelete, "/terms/"+id, nil)
	if gone.status != http.StatusNoContent || len(gone.raw) != 0 {
		t.Fatalf("delete = %d %s", gone.status, gone.raw)
	}
	h.wantError(h.do(http.MethodDelete, "/terms/"+id, nil), http.StatusNotFound, "term_not_found")
	changes := []string{}
	for _, ev := range h.events.OfType(tangent.EventTermsChanged) {
		changes = append(changes, ev.Data.(tangent.TermsChange).Change)
	}
	if len(changes) != 4 || changes[0] != "created" || changes[3] != "deleted" {
		t.Fatalf("terms.changed = %v", changes)
	}
}

func TestTermRoutes_SavingFromAnAsideKeepsIt(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "which pool mode?")
	aside := h.answeredAside(main, reply, nil)
	saved := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+aside+"/terms", map[string]any{"term": "pool", "explanation": "reused connections"}))
	if field(saved, "keptBranch", "lineId") != aside || field(saved, "keptBranch", "keptAt") == nil || field(saved, "term", "sourceLineId") != aside {
		t.Fatalf("saved = %v", saved)
	}
	branch := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+aside+"/branch", nil))
	if field(branch, "branch", "keptAt") == nil {
		t.Fatalf("the aside is kept: %v", branch)
	}
}

func TestTermRoutes_ThePreviewCarriesTheTerms(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	h.turn(main, "q")
	h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/terms", map[string]any{"term": "MVCC", "explanation": "SECRET-EXPLANATION"}))
	preview := h.do(http.MethodPost, "/lines/"+main+"/preview", map[string]any{"content": "next"})
	body := h.ok(http.StatusOK, preview)
	trailing := field(body, "prompt", "trailing").([]any)
	if len(trailing) == 0 || trailing[0].(map[string]any)["key"] != "glossary" {
		t.Fatalf("trailing = %v", trailing)
	}
	if strings.Contains(string(preview.raw), "SECRET-EXPLANATION") {
		t.Fatal("an explanation reached the preview")
	}
}
