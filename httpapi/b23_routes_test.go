package httpapi_test

import (
	"net/http"
	"testing"

	"github.com/Rynvex/tangent/tangent"
)

// B23: PUT /branch/keep, POST /branch/continue, DELETE /branch.

// b23Seed adds, on the arena line, an aside that got its answer and a
// discarded branch.
func (h *harness) b23Seed(s *seeded) {
	h.t.Helper()
	s.aside = h.answeredAside(s.arena, s.arenaReply, nil)
	s.discarded = h.branch(s.arena, s.arenaReply, "a dead end")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+s.discarded+"/branch/discard", nil))
}

// answeredAside opens an aside on the anchor (extra fields join the body)
// and gets it its one answer.
func (h *harness) answeredAside(parentID, anchorID string, extra map[string]any) string {
	h.t.Helper()
	body := map[string]any{"anchorMessageId": anchorID, "purpose": "quick check", "kind": "aside"}
	for k, v := range extra {
		body[k] = v
	}
	aside := field(h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+parentID+"/branches", body)), "line", "id").(string)
	h.turn(aside, "what does that mean?")
	return aside
}

// b23Routes are the B23 routes.
func b23Routes(s seeded) []routeCase {
	aside, discarded := "/lines/"+s.aside+"/branch", "/lines/"+s.discarded+"/branch"
	return []routeCase{
		{name: "keep aside", method: "PUT", path: aside + "/keep", body: map[string]any{"keep": true}, write: true, lineScoped: true, feature: "aside",
			bad: badRequest{body: map[string]any{}, status: 400, code: "invalid_input"}},
		{name: "continue aside", method: "POST", path: aside + "/continue", write: true, lineScoped: true, feature: "aside",
			bad: badRequest{body: map[string]any{"kind": "aside"}, status: 400, code: "kind_unsupported"}},
		{name: "delete branch", method: "DELETE", path: discarded, write: true, lineScoped: true,
			bad: badRequest{path: "/lines/" + s.arena + "/branch", status: 400, code: "invalid_input"}},
	}
}

func TestB23Routes_KeepAnAside(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "which pool mode?")
	aside := h.answeredAside(main, reply, nil)
	path := "/lines/" + aside + "/branch/keep"
	before := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+aside+"/branch", nil))
	if _, has := before["branch"].(map[string]any)["keptAt"]; has {
		t.Fatalf("an aside that is not kept has no keptAt: %v", before["branch"])
	}
	kept := h.ok(http.StatusOK, h.do(http.MethodPut, path, map[string]any{"keep": true}))
	if field(kept, "branch", "keptAt") == nil || field(kept, "branch", "lineId") != aside || field(kept, "branch", "status") != "discarded" {
		t.Fatalf("kept = %v", kept)
	}
	changes := 0
	for _, ev := range h.events.OfType(tangent.EventBranchChanged) {
		if ev.Data.(tangent.BranchChange).Change == tangent.BranchKept {
			changes++
		}
	}
	if changes != 1 {
		t.Fatalf("%d branch.changed{kept}", changes)
	}
	// The outline shows it too.
	outline := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/branches?includeAside=true", nil))
	if rows := outline["branches"].([]any); len(rows) != 1 || rows[0].(map[string]any)["keptAt"] == nil {
		t.Fatalf("outline = %v", outline)
	}
	released := h.ok(http.StatusOK, h.do(http.MethodPut, path, map[string]any{"keep": false}))
	if _, has := released["branch"].(map[string]any)["keptAt"]; has {
		t.Fatalf("released = %v", released)
	}
	// Opened kept.
	born := h.answeredAside(main, reply, map[string]any{"keep": true})
	if got := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+born+"/branch", nil)); field(got, "branch", "keptAt") == nil {
		t.Fatalf("an aside opened kept = %v", got)
	}
	// Refusals.
	r := h.do(http.MethodPut, path, map[string]any{})
	h.wantError(r, http.StatusBadRequest, "invalid_input")
	if r.json(t)["field"] != "keep" {
		t.Fatalf("field = %v", r.json(t)["field"])
	}
	h.wantError(h.do(http.MethodPut, path, map[string]any{"keep": "yes"}), http.StatusBadRequest, "invalid_input")
	branch := h.branch(main, reply, "a branch")
	h.wantError(h.do(http.MethodPut, "/lines/"+branch+"/branch/keep", map[string]any{"keep": true}), http.StatusBadRequest, "kind_unsupported")
	h.wantError(h.do(http.MethodPut, "/lines/"+main+"/branch/keep", map[string]any{"keep": true}), http.StatusNotFound, "branch_not_found")
	r = h.do(http.MethodPost, "/lines/"+main+"/branches", map[string]any{"anchorMessageId": reply, "purpose": "p", "kind": "investigate", "keep": true})
	h.wantError(r, http.StatusBadRequest, "invalid_input")
	if r.json(t)["field"] != "keep" {
		t.Fatalf("field = %v", r.json(t)["field"])
	}
}

func TestB23Routes_ContinueAnAside(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "which pool mode?")
	aside := h.answeredAside(main, reply, nil)
	before := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+aside+"/messages", nil))["messages"].([]any)
	out := h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+aside+"/branch/continue", nil))
	line := field(out, "line", "id").(string)
	if out["replacedLineId"] != aside || line == aside || field(out, "branch", "lineId") != line || field(out, "branch", "kind") != "investigate" ||
		field(out, "branch", "status") != "open" || field(out, "branch", "purpose") != "quick check" || field(out, "branch", "anchorMessageId") != reply ||
		field(out, "line", "conversationBranch", "parentLineId") != main {
		t.Fatalf("continued = %v", out)
	}
	h.wantError(h.do(http.MethodGet, "/lines/"+aside, nil), http.StatusNotFound, "line_not_found")
	after := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+line+"/messages", nil))["messages"].([]any)
	if len(after) != 2 || len(before) != 2 {
		t.Fatalf("messages: %d before, %d after", len(before), len(after))
	}
	for i := range after {
		was, is := before[i].(map[string]any), after[i].(map[string]any)
		if was["id"] != is["id"] || was["seq"] != is["seq"] || is["lineId"] != line {
			t.Fatalf("message %d: %v, was %v", i, is, was)
		}
	}
	// The new branch takes another turn.
	h.turn(line, "and how big?")
	if got := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+line+"/messages", nil))["messages"].([]any); len(got) != 4 {
		t.Fatalf("%d messages after another turn", len(got))
	}
	// Refusals.
	h.wantError(h.do(http.MethodPost, "/lines/"+aside+"/branch/continue", nil), http.StatusNotFound, "branch_not_found")
	h.wantError(h.do(http.MethodPost, "/lines/"+line+"/branch/continue", nil), http.StatusBadRequest, "kind_unsupported")
	second := h.answeredAside(main, reply, nil)
	path := "/lines/" + second + "/branch/continue"
	h.wantError(h.do(http.MethodPost, path, map[string]any{"kind": "aside"}), http.StatusBadRequest, "kind_unsupported")
	h.wantError(h.do(http.MethodPost, path, map[string]any{"hostMeta": map[string]any{"a": 1}}), http.StatusBadRequest, "invalid_input")
	open := field(h.ok(http.StatusCreated, h.do(http.MethodPost, "/lines/"+main+"/branches", map[string]any{"anchorMessageId": reply, "purpose": "q", "kind": "aside"})), "line", "id").(string)
	h.wantError(h.do(http.MethodPost, "/lines/"+open+"/branch/continue", nil), http.StatusConflict, "branch_busy")
	named := h.ok(http.StatusCreated, h.do(http.MethodPost, path, map[string]any{"purpose": "pool sizing", "kind": "alternative"}))
	if field(named, "branch", "purpose") != "pool sizing" || field(named, "branch", "kind") != "alternative" {
		t.Fatalf("named = %v", named)
	}
}

func TestB23Routes_DeleteAnEndedBranch(t *testing.T) {
	h := newHarness(t)
	main := h.line()
	reply := h.turn(main, "which pool mode?")
	branch := h.branch(main, reply, "a dead end")
	inner := h.branch(branch, h.turn(branch, "in the branch"), "deeper")
	path := "/lines/" + branch + "/branch"
	h.wantError(h.do(http.MethodDelete, path, nil), http.StatusConflict, "branch_not_deletable")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+branch+"/branch/discard", nil))
	h.wantError(h.do(http.MethodDelete, path, nil), http.StatusConflict, "branch_busy")
	h.ok(http.StatusOK, h.do(http.MethodPost, "/lines/"+inner+"/branch/discard", nil))
	h.wantError(h.do(http.MethodDelete, "/lines/"+main+"/branch", nil), http.StatusBadRequest, "invalid_input")
	h.wantError(h.do(http.MethodDelete, "/lines/"+unknownID+"/branch", nil), http.StatusNotFound, "line_not_found")
	out := h.ok(http.StatusOK, h.do(http.MethodDelete, path, nil))
	ids, _ := out["lineIds"].([]any)
	if out["rootLineId"] != main || len(ids) != 2 || ids[0] != branch || ids[1] != inner {
		t.Fatalf("deleted = %v", out)
	}
	h.wantError(h.do(http.MethodGet, "/lines/"+branch, nil), http.StatusNotFound, "line_not_found")
	h.wantError(h.do(http.MethodGet, "/lines/"+inner, nil), http.StatusNotFound, "line_not_found")
	if outline := h.ok(http.StatusOK, h.do(http.MethodGet, "/lines/"+main+"/branches?includeAside=true", nil)); len(outline["branches"].([]any)) != 0 {
		t.Fatalf("outline = %v", outline)
	}
	// An ended aside goes at once.
	aside := h.answeredAside(main, reply, nil)
	if out := h.ok(http.StatusOK, h.do(http.MethodDelete, "/lines/"+aside+"/branch", nil)); len(out["lineIds"].([]any)) != 1 {
		t.Fatalf("deleted aside = %v", out)
	}
	h.wantError(h.do(http.MethodDelete, "/lines/"+aside+"/branch", nil), http.StatusNotFound, "line_not_found")
}
